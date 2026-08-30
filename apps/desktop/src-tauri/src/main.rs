// newhorse desktop shell — a THIN wrapper around the runtime server:
// spawn the compiled server sidecar, wait for it to listen, open a webview on
// the served UI (same origin as the API). The wrapper holds NO domain logic:
// all behavior lives in the engine; the shell only manages process + window.
//
// LAN access (手机端开关): the engine's own settings page writes `host` /
// `port` / `token` into ~/.newhorse/config.json; this shell reads that file on
// every server (re)start and passes it to the sidecar via env — switching LAN
// access = change settings + 重启服务 (restart_server command).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::net::TcpStream;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

struct ServerChild(Mutex<Option<Child>>);

#[derive(Serialize)]
struct ServerInfo {
    url: String,
    pid: u32,
}

fn engine_home() -> String {
    std::env::var("AGENT_RUNTIME_HOME").unwrap_or_else(|_| {
        let home = std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_default();
        format!("{home}\\.newhorse")
    })
}

/// Read the engine's own config.json (written by the UI settings page).
fn engine_config() -> (String, u16, Option<String>) {
    let path = format!("{}\\config.json", engine_home());
    let mut host = "127.0.0.1".to_string();
    let mut port: u16 = 3927;
    let mut token: Option<String> = None;
    if let Ok(text) = std::fs::read_to_string(&path) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(h) = v.get("host").and_then(|x| x.as_str()) {
                host = h.to_string();
            }
            if let Some(p) = v.get("port").and_then(|x| x.as_u64()) {
                port = u16::try_from(p).unwrap_or(3927);
            }
            if let Some(t) = v.get("token").and_then(|x| x.as_str()) {
                token = Some(t.to_string());
            }
        }
    }
    (host, port, token)
}

fn spawn_server(app: &tauri::AppHandle) -> Result<ServerInfo, String> {
    // The bundled sidecar sits NEXT to the main executable; the web-dist
    // resource ships under the resource directory.
    let exe = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("newhorse-server.exe")))
        .ok_or("cannot locate the server sidecar next to the executable")?;
    let ui = app
        .path()
        .resource_dir()
        .map_err(|e| format!("resolve resource dir: {e}"))?
        .join("web-dist");
    let (host, port, token) = engine_config();
    let mut cmd = Command::new(&exe);
    cmd.env("NEWHORSE_HOST", &host)
        .env("NEWHORSE_PORT", port.to_string())
        .env("NEWHORSE_UI_DIR", &ui)
        .env("AGENT_RUNTIME_HOME", engine_home());
    if let Some(t) = token {
        cmd.env("NEWHORSE_TOKEN", t);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW — the server is a daemon, not a console
    }
    let child = cmd.spawn().map_err(|e| format!("spawn server: {e}"))?;
    let pid = child.id();
    *app.state::<ServerChild>().0.lock().unwrap() = Some(child);
    Ok(ServerInfo { url: format!("http://{}:{port}", if host == "0.0.0.0" { "127.0.0.1" } else { &host }), pid })
}

fn wait_listen(host: &str, port: u16) -> bool {
    let target = (if host == "0.0.0.0" { "127.0.0.1" } else { host }, port);
    for _ in 0..150 {
        if TcpStream::connect(target).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    false
}

fn kill_child(state: &ServerChild) {
    if let Some(mut child) = state.0.lock().unwrap().take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[tauri::command]
fn restart_server(app: tauri::AppHandle) -> Result<ServerInfo, String> {
    kill_child(&app.state::<ServerChild>());
    let info = spawn_server(&app)?;
    let (host, port, _) = engine_config();
    wait_listen(&host, port);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.eval(&format!("location.href = '{}'", info.url));
    }
    Ok(info)
}

#[tauri::command]
fn server_info() -> ServerInfo {
    let (host, port, _) = engine_config();
    ServerInfo {
        url: format!("http://{}:{port}", if host == "0.0.0.0" { "127.0.0.1" } else { &host }),
        pid: 0,
    }
}

fn main() {
    let show_console = std::env::var("NEWHORSE_SHELL_DEBUG").is_ok();
    tauri::Builder::default()
        .manage(ServerChild(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![restart_server, server_info])
        .setup(move |app| {
            let info = spawn_server(app.handle()).map_err(|e| e.to_string())?;
            let (host, port, _) = engine_config();
            if !wait_listen(&host, port) && !show_console {
                eprintln!("server did not start listening in time");
            }
            let url: tauri::Url = info.url.parse().map_err(|e| format!("{e}"))?;
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("newhorse")
                .inner_size(1280.0, 820.0)
                .min_inner_size(420.0, 560.0)
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                let state = app.state::<ServerChild>();
                kill_child(state.inner());
            }
        });
}
