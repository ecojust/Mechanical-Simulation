pub mod mcp;

#[cfg(feature = "desktop")]
use tauri::Manager;
#[cfg(feature = "desktop")]
use tauri_plugin_dialog::DialogExt;

/// The renderer supplies content, never a filesystem path. The user chooses the destination.
#[cfg(feature = "desktop")]
#[tauri::command]
async fn save_export(
    app: tauri::AppHandle,
    filename: String,
    content: String,
) -> Result<bool, String> {
    if content.len() > 100 * 1024 * 1024 {
        return Err("导出文件超过 100 MB 限制".into());
    }
    let filename: String = filename
        .chars()
        .filter(|c| !c.is_control() && !"/\\<>:\"|?*".contains(*c))
        .take(200)
        .collect();
    let filename = if filename.is_empty() {
        "assembly.json".to_string()
    } else {
        filename
    };
    tauri::async_runtime::spawn_blocking(move || {
        let selection = app
            .dialog()
            .file()
            .set_title("保存工作台文件")
            .set_file_name(filename)
            .blocking_save_file();
        let Some(selection) = selection else {
            return Ok(false);
        };
        let path = selection.into_path().map_err(|error| error.to_string())?;
        std::fs::write(path, content.as_bytes()).map_err(|error| error.to_string())?;
        Ok(true)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(feature = "desktop")]
pub fn run() {
    let isolated = std::env::var_os("MECHANICAL_STUDIO_DATA_DIR").is_some();
    let mut context = tauri::generate_context!();
    if isolated {
        // A separate MCP discovery directory alone does not isolate WKWebView storage.
        // Release smoke tests must never load or modify a user's normal assembly.
        for window in &mut context.config_mut().app.windows {
            window.incognito = true;
            window.data_directory = None;
            window.data_store_identifier = None;
        }
    }
    let mut builder = tauri::Builder::default();
    if !isolated {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }));
    }
    builder
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            save_export,
            mcp::desktop::mcp_reply,
            mcp::desktop::mcp_status,
            mcp::desktop::mcp_set_enabled
        ])
        .setup(|app| {
            mcp::start_bridge(app.handle().clone())?;
            Ok(())
        })
        .run(context)
        .expect("Mechanical Studio could not start");
}
