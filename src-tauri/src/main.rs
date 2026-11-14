#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {
    if std::env::args().any(|arg| arg == "--mcp") {
        if let Err(error) = mechanical_studio_lib::mcp::run_stdio() {
            eprintln!("MCP server failed: {error}");
            std::process::exit(1);
        }
        return;
    }
    #[cfg(feature = "desktop")]
    mechanical_studio_lib::run();
    #[cfg(not(feature = "desktop"))]
    eprintln!("This build contains the MCP transport only. Start it with --mcp.");
}
