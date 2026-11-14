//! MCP stdio transport and a private, loopback-only bridge into the running WebView.
//! No Node runtime, shell command, remote model URL or arbitrary file tool is exposed.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    sync::Arc,
    time::Duration,
};
use uuid::Uuid;
const MAX_REQUEST: usize = 24 * 1024 * 1024;
const MAX_RESPONSE: usize = 128 * 1024 * 1024;
// The official MCP SDK defaults to a 10 MiB stdio message buffer.
const MAX_STDIO_RESPONSE: usize = 9 * 1024 * 1024;
const TOOLS: &str = include_str!("../../src/mcp/tools.json");
type Handler = Arc<dyn Fn(Value) -> Result<Value, String> + Send + Sync>;

#[derive(Clone, Serialize, Deserialize)]
struct Discovery {
    version: u8,
    address: String,
    token: String,
}

pub fn data_dir() -> PathBuf {
    if let Some(path) = std::env::var_os("MECHANICAL_STUDIO_DATA_DIR") {
        return PathBuf::from(path);
    }
    #[cfg(target_os = "macos")]
    {
        return PathBuf::from(std::env::var_os("HOME").unwrap_or_default())
            .join("Library/Application Support/org.ecojust.mechanical-simulation");
    }
    #[cfg(target_os = "windows")]
    {
        return PathBuf::from(std::env::var_os("APPDATA").unwrap_or_default())
            .join("org.ecojust.mechanical-simulation");
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".local/share")
            })
            .join("org.ecojust.mechanical-simulation")
    }
}
fn discovery_path() -> PathBuf {
    data_dir().join("mcp-connection.json")
}
fn write_discovery(value: &Discovery) -> Result<(), String> {
    let dir = data_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    }
    let temporary = dir.join(format!(".mcp-{}.tmp", Uuid::new_v4()));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary).map_err(|e| e.to_string())?;
    file.write_all(serde_json::to_string(value).unwrap().as_bytes())
        .map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    fs::rename(temporary, discovery_path()).map_err(|e| e.to_string())
}
fn constant_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.bytes()
        .zip(b.bytes())
        .fold(0u8, |acc, (x, y)| acc | (x ^ y))
        == 0
}
fn response(stream: &mut TcpStream, code: u16, value: Value) {
    let body = serde_json::to_vec(&value).unwrap_or_default();
    let header=format!("HTTP/1.1 {code} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n",if code==200{"OK"}else{"Error"},body.len());
    let _ = stream
        .write_all(header.as_bytes())
        .and_then(|_| stream.write_all(&body));
}
fn serve_connection(mut stream: TcpStream, discovery: &Discovery, handler: &Handler) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(15)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(45)));
    let mut reader = BufReader::new(&mut stream);
    let mut lines = Vec::new();
    let mut bytes = 0usize;
    loop {
        let mut line = String::new();
        let read = reader
            .by_ref()
            .take((8193usize.saturating_sub(bytes)) as u64)
            .read_line(&mut line);
        match read {
            Ok(0) | Err(_) => return,
            Ok(n) => bytes += n,
        };
        if bytes > 8192 {
            drop(reader);
            response(
                &mut stream,
                431,
                json!({"error":"Request headers too large"}),
            );
            return;
        }
        if line == "\r\n" {
            break;
        }
        lines.push(line);
    }
    if lines.first().map(|s| s.trim_end()) != Some("POST /rpc HTTP/1.1") {
        drop(reader);
        response(&mut stream, 404, json!({"error":"Not found"}));
        return;
    }
    let mut headers = std::collections::HashMap::new();
    for line in &lines[1..] {
        let Some((key, value)) = line.split_once(':') else {
            drop(reader);
            response(&mut stream, 400, json!({"error":"Malformed header"}));
            return;
        };
        let key = key.trim().to_ascii_lowercase();
        if headers.insert(key, value.trim().to_string()).is_some() {
            drop(reader);
            response(&mut stream, 400, json!({"error":"Duplicate header"}));
            return;
        }
    }
    let host_ok = headers
        .get("host")
        .map(|v| v == &discovery.address)
        .unwrap_or(false);
    let auth_ok = headers
        .get("authorization")
        .map(|v| constant_eq(v, &format!("Bearer {}", discovery.token)))
        .unwrap_or(false);
    if !host_ok
        || !auth_ok
        || headers.contains_key("origin")
        || headers.contains_key("transfer-encoding")
    {
        drop(reader);
        response(&mut stream, 403, json!({"error":"Forbidden"}));
        return;
    }
    let length = headers
        .get("content-length")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(0);
    if length == 0 || length > MAX_REQUEST {
        drop(reader);
        response(
            &mut stream,
            413,
            json!({"error":"Request too large or empty"}),
        );
        return;
    }
    let mut data = vec![0u8; length];
    if reader.read_exact(&mut data).is_err() {
        return;
    }
    drop(reader);
    let value: Value = match serde_json::from_slice(&data) {
        Ok(value) => value,
        Err(_) => {
            response(&mut stream, 400, json!({"error":"Invalid JSON"}));
            return;
        }
    };
    match handler(value) {
        Ok(result) => response(&mut stream, 200, json!({"result":result})),
        Err(error) => response(&mut stream, 200, json!({"error":error})),
    }
}
fn start_tcp_bridge(handler: Handler) -> Result<Discovery, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let discovery = Discovery {
        version: 1,
        address: listener
            .local_addr()
            .map_err(|e| e.to_string())?
            .to_string(),
        token: format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple()),
    };
    write_discovery(&discovery)?;
    let shared = discovery.clone();
    // Serial processing is intentional: it preserves desktop command order and bounds memory.
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            match stream {
                Ok(stream) => serve_connection(stream, &shared, &handler),
                Err(_) => break,
            }
        }
    });
    Ok(discovery)
}
fn forward(method: &str, args: Value) -> Result<Value, String> {
    let bytes = fs::read(discovery_path())
        .map_err(|_| "请先打开 Mechanical Studio 桌面客户端，再连接 MCP。".to_string())?;
    if bytes.len() > 4096 {
        return Err("Invalid MCP discovery file".into());
    }
    let discovery: Discovery =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid MCP discovery file".to_string())?;
    let address: std::net::SocketAddr = discovery
        .address
        .parse()
        .map_err(|_| "Invalid bridge address".to_string())?;
    if discovery.version != 1
        || address.ip() != std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST)
        || discovery.token.len() != 64
    {
        return Err("Only the local authenticated desktop bridge is allowed".into());
    }
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(3))
        .map_err(|_| "桌面客户端尚未运行或连接已失效，请打开应用后重试。".to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(50)))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(15)))
        .map_err(|e| e.to_string())?;
    let body =
        serde_json::to_vec(&json!({"method":method,"args":args})).map_err(|e| e.to_string())?;
    if body.len() > MAX_REQUEST {
        return Err("MCP request exceeds 24 MiB".into());
    }
    let header=format!("POST /rpc HTTP/1.1\r\nHost: {}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",discovery.address,discovery.token,body.len());
    stream
        .write_all(header.as_bytes())
        .and_then(|_| stream.write_all(&body))
        .map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    stream
        .take(MAX_RESPONSE as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| {
            "Desktop command timed out; reopen the workbench and retry with its current revision"
                .to_string()
        })?;
    if bytes.len() > MAX_RESPONSE {
        return Err("Desktop response exceeds size limit".into());
    }
    let separator = bytes
        .windows(4)
        .position(|v| v == b"\r\n\r\n")
        .ok_or("Invalid bridge response")?;
    if !bytes.starts_with(b"HTTP/1.1 200 ") {
        return Err("Desktop bridge refused this request".into());
    }
    let response: Value = serde_json::from_slice(&bytes[separator + 4..])
        .map_err(|_| "Invalid bridge response".to_string())?;
    if let Some(error) = response.get("error").and_then(Value::as_str) {
        return Err(error.into());
    }
    response
        .get("result")
        .cloned()
        .ok_or("Missing bridge result".into())
}
fn error(id: Value, code: i64, message: &str) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})
}
fn rpc(request: Value, initialized: &mut bool) -> Option<Value> {
    let id = request.get("id").cloned();
    if request.get("jsonrpc") != Some(&json!("2.0"))
        || !request.get("method").is_some_and(Value::is_string)
    {
        return Some(error(
            id.unwrap_or(Value::Null),
            -32600,
            "Invalid JSON-RPC request",
        ));
    }
    let method = request["method"].as_str().unwrap();
    if id.is_none() {
        return None;
    }
    let id = id.unwrap();
    if !(id.is_string() || id.is_number()) {
        return Some(error(
            Value::Null,
            -32600,
            "Request id must be a string or number",
        ));
    }
    let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
    if !params.is_object() {
        return Some(error(id, -32602, "Parameters must be an object"));
    }
    let result = match method {
        "initialize" => {
            if !params.get("protocolVersion").is_some_and(Value::is_string)
                || !params.get("capabilities").is_some_and(Value::is_object)
                || !params.get("clientInfo").is_some_and(|v| {
                    v.get("name").is_some_and(Value::is_string)
                        && v.get("version").is_some_and(Value::is_string)
                })
            {
                return Some(error(
                    id,
                    -32602,
                    "initialize requires protocolVersion, capabilities and clientInfo",
                ));
            }
            *initialized = true;
            let requested = params["protocolVersion"].as_str().unwrap();
            let version =
                if ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"].contains(&requested) {
                    requested
                } else {
                    "2025-06-18"
                };
            json!({"protocolVersion":version,"capabilities":{"tools":{"listChanged":false},"resources":{"subscribe":false,"listChanged":false}},"serverInfo":{"name":"mechanical-studio","version":env!("CARGO_PKG_VERSION")},"instructions":"Operate the running Mechanical Studio workbench. Read get_project first; mutations require expectedRevision. Model imports must supply declared functional type and interaction parameters. Unconfigured/proxy models are not manufacturing-certified."})
        }
        "ping" => json!({}),
        _ if !*initialized => return Some(error(id, -32002, "Initialize the MCP session first")),
        "tools/list" => json!({"tools":serde_json::from_str::<Value>(TOOLS).unwrap()}),
        "tools/call" => {
            let Some(name) = params.get("name").and_then(Value::as_str) else {
                return Some(error(id, -32602, "Missing tool name"));
            };
            let tools: Vec<Value> = serde_json::from_str(TOOLS).unwrap();
            if !tools.iter().any(|tool| tool["name"] == name) {
                return Some(error(id, -32602, "Unknown tool"));
            }
            let arguments = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            if !arguments.is_object() {
                return Some(error(id, -32602, "Tool arguments must be an object"));
            }
            match forward(name, arguments) {
                Ok(result) => {
                    json!({"content":[{"type":"text","text":serde_json::to_string(&result).unwrap()}],"structuredContent":result,"isError":false})
                }
                Err(message) => json!({"content":[{"type":"text","text":message}],"isError":true}),
            }
        }
        "resources/list" => {
            json!({"resources":[{"uri":"mechanical://project","name":"Active assembly","mimeType":"application/json","description":"Current project metadata and revision; excludes model bytes"},{"uri":"mechanical://component-types","name":"Functional component types","mimeType":"application/json"}]})
        }
        "resources/templates/list" => json!({"resourceTemplates":[]}),
        "resources/read" => {
            let uri = params.get("uri").and_then(Value::as_str).unwrap_or("");
            let target = match uri {
                "mechanical://project" => "get_project",
                "mechanical://component-types" => "list_component_types",
                _ => return Some(error(id, -32602, "Unknown resource URI")),
            };
            match forward(target, json!({})) {
                Ok(value) => {
                    json!({"contents":[{"uri":uri,"mimeType":"application/json","text":serde_json::to_string(&value).unwrap()}]})
                }
                Err(message) => return Some(error(id, -32000, &message)),
            }
        }
        _ => return Some(error(id, -32601, "Method not found")),
    };
    Some(json!({"jsonrpc":"2.0","id":id,"result":result}))
}
pub fn run_stdio() -> Result<(), Box<dyn std::error::Error>> {
    let stdin = std::io::stdin();
    let mut input = stdin.lock();
    let stdout = std::io::stdout();
    let mut output = stdout.lock();
    let mut initialized = false;
    loop {
        let mut line = Vec::new();
        let size = input
            .by_ref()
            .take(MAX_REQUEST as u64 + 1)
            .read_until(b'\n', &mut line)?;
        if size == 0 {
            break;
        }
        if size > MAX_REQUEST {
            return Err("MCP request line exceeds 24 MiB".into());
        }
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let reply = match serde_json::from_slice(&line) {
            Ok(value) => rpc(value, &mut initialized),
            Err(_) => Some(error(Value::Null, -32700, "Parse error")),
        };
        if let Some(reply) = reply {
            let bytes = encode_reply(reply)?;
            output.write_all(&bytes)?;
            output.write_all(b"\n")?;
            output.flush()?;
        }
    }
    Ok(())
}
fn encode_reply(reply: Value) -> Result<Vec<u8>, serde_json::Error> {
    let bytes = serde_json::to_vec(&reply)?;
    if bytes.len() > MAX_STDIO_RESPONSE {
        return serde_json::to_vec(&error(reply["id"].clone(), -32000,
            "Response exceeds the standard MCP client buffer; use export_project with chunkIndex and expectedRevision, or export in the desktop app."));
    }
    Ok(bytes)
}

#[cfg(feature = "desktop")]
pub mod desktop {
    use super::*;
    use std::{
        collections::HashMap,
        sync::{
            atomic::{AtomicBool, Ordering},
            mpsc, Mutex,
        },
    };
    use tauri::{Emitter, Manager};
    pub struct BridgeState {
        discovery: Discovery,
        enabled: Arc<AtomicBool>,
        pending: Arc<Mutex<HashMap<String, mpsc::SyncSender<Result<Value, String>>>>>,
    }
    pub fn start_bridge(app: tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
        let pending = Arc::new(Mutex::new(HashMap::<
            String,
            mpsc::SyncSender<Result<Value, String>>,
        >::new()));
        let requests = pending.clone();
        let handle = app.clone();
        let enabled = Arc::new(AtomicBool::new(true));
        let permit = enabled.clone();
        let handler: Handler = Arc::new(move |request| {
            if !permit.load(Ordering::SeqCst) {
                return Err("MCP已在桌面工作台中停用。".into());
            }
            let method = request
                .get("method")
                .and_then(Value::as_str)
                .ok_or("Missing method")?;
            let args = request.get("args").cloned().unwrap_or_else(|| json!({}));
            let id = Uuid::new_v4().to_string();
            let (tx, rx) = mpsc::sync_channel(1);
            requests
                .lock()
                .map_err(|_| "Bridge unavailable")?
                .insert(id.clone(), tx);
            if handle
                .emit_to(
                    "main",
                    "mechanical-mcp-request",
                    json!({"id":id,"method":method,"args":args}),
                )
                .is_err()
            {
                requests.lock().unwrap().remove(&id);
                return Err("Desktop WebView is unavailable".into());
            }
            let result = rx
                .recv_timeout(Duration::from_secs(40))
                .unwrap_or_else(|_| Err("工作台尚未就绪或操作超时；请打开主窗口并重试。".into()));
            requests.lock().unwrap().remove(&id);
            result
        });
        let discovery = start_tcp_bridge(handler).map_err(std::io::Error::other)?;
        app.manage(BridgeState {
            discovery,
            pending,
            enabled,
        });
        Ok(())
    }
    #[tauri::command]
    pub fn mcp_reply(
        id: String,
        result: Option<Value>,
        error: Option<String>,
        state: tauri::State<'_, BridgeState>,
    ) -> Result<(), String> {
        let sender = state
            .pending
            .lock()
            .map_err(|_| "Bridge unavailable")?
            .remove(&id)
            .ok_or("Request is expired or unknown")?;
        sender
            .send(if let Some(error) = error {
                Err(error)
            } else {
                Ok(result.unwrap_or(Value::Null))
            })
            .map_err(|_| "MCP caller disconnected".into())
    }
    #[tauri::command]
    pub fn mcp_set_enabled(
        enabled: bool,
        state: tauri::State<'_, BridgeState>,
    ) -> Result<(), String> {
        state.enabled.store(enabled, Ordering::SeqCst);
        Ok(())
    }
    #[tauri::command]
    pub fn mcp_status(state: tauri::State<'_, BridgeState>) -> Result<Value, String> {
        let executable = std::env::current_exe().map_err(|e| e.to_string())?;
        Ok(
            json!({"active":state.enabled.load(Ordering::SeqCst),"endpoint":format!("http://{}/rpc",state.discovery.address),"config":{"mcpServers":{"mechanical-studio":{"command":executable,"args":["--mcp"]}}}}),
        )
    }
}
#[cfg(feature = "desktop")]
pub use desktop::{mcp_reply, mcp_set_enabled, mcp_status, start_bridge};

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn protocol_initializes_and_lists_real_tools() {
        let mut initialized = false;
        let r=rpc(json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}),&mut initialized).unwrap();
        assert_eq!(r["result"]["protocolVersion"], "2025-06-18");
        let r = rpc(
            json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}),
            &mut initialized,
        )
        .unwrap();
        assert!(r["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["name"] == "transform_part"));
    }
    #[test]
    fn rejects_unknown_methods_and_tool_names() {
        let mut initialized = true;
        assert_eq!(
            rpc(
                json!({"jsonrpc":"2.0","id":1,"method":"exec"}),
                &mut initialized
            )
            .unwrap()["error"]["code"],
            -32601
        );
        assert_eq!(
            rpc(
                json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"shell"}}),
                &mut initialized
            )
            .unwrap()["error"]["code"],
            -32602
        );
    }
    #[test]
    fn initialization_required() {
        assert_eq!(
            rpc(
                json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}),
                &mut false
            )
            .unwrap()["error"]["code"],
            -32002
        );
    }
    #[test]
    fn credentials_are_exact() {
        assert!(constant_eq("abc", "abc"));
        assert!(!constant_eq("abc", "abd"));
        assert!(!constant_eq("abc", "abcd"));
    }
    #[test]
    fn malformed_initialization_does_not_open_session() {
        let mut initialized = false;
        assert_eq!(
            rpc(
                json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}),
                &mut initialized
            )
            .unwrap()["error"]["code"],
            -32602
        );
        assert!(!initialized);
    }
    #[test]
    fn private_http_bridge_checks_host_token_origin_and_body() {
        fn exchange(host: Option<&str>, authorization: &str, extra: &str, body: &str) -> String {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let discovery = Discovery {
                version: 1,
                address: address.to_string(),
                token: "a".repeat(64),
            };
            let handler: Handler = Arc::new(|v| Ok(json!({"echo":v["method"]})));
            let server = std::thread::spawn(move || {
                serve_connection(listener.accept().unwrap().0, &discovery, &handler)
            });
            let mut stream = TcpStream::connect(address).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let request=format!("POST /rpc HTTP/1.1\r\nHost: {}\r\nAuthorization: {}\r\nContent-Length: {}\r\n{}\r\n{}",host.map(str::to_string).unwrap_or(address.to_string()),authorization,body.len(),extra,body);
            stream.write_all(request.as_bytes()).unwrap();
            let mut response = String::new();
            stream.read_to_string(&mut response).unwrap();
            server.join().unwrap();
            response
        }
        let auth = format!("Bearer {}", "a".repeat(64));
        let body = r#"{"method":"get_project","args":{}}"#;
        let valid = exchange(None, &auth, "", body);
        assert!(valid.starts_with("HTTP/1.1 200"));
        assert!(valid.contains("get_project"));
        assert!(exchange(None, "Bearer wrong", "", body).starts_with("HTTP/1.1 403"));
        assert!(exchange(Some("attacker.example"), &auth, "", body).starts_with("HTTP/1.1 403"));
        assert!(
            exchange(None, &auth, "Origin: https://attacker.example\r\n", body)
                .starts_with("HTTP/1.1 403")
        );
        assert!(
            exchange(None, &auth, "Transfer-Encoding: chunked\r\n", body)
                .starts_with("HTTP/1.1 403")
        );
        assert!(exchange(None, &auth, "", "not-json").starts_with("HTTP/1.1 400"));
    }
}
