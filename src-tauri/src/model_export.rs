//! Bounded binary model export. A renderer can supply bytes, never a destination path.
const MAX_MODEL_BYTES: usize = 256 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ModelFormat {
    Glb,
    Stl,
}
impl ModelFormat {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "glb" => Ok(Self::Glb),
            "stl" => Ok(Self::Stl),
            _ => Err("仅支持 GLB 或二进制 STL 导出".into()),
        }
    }
    fn extension(self) -> &'static str {
        match self {
            Self::Glb => "glb",
            Self::Stl => "stl",
        }
    }
}
fn word(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
}
fn validate_size(length: usize) -> Result<(), String> {
    if length == 0 || length > MAX_MODEL_BYTES {
        return Err("模型导出不能为空且不能超过 256 MiB".into());
    }
    Ok(())
}
fn validate_model(bytes: &[u8], format: ModelFormat) -> Result<(), String> {
    validate_size(bytes.len())?;
    match format {
        ModelFormat::Glb => validate_glb(bytes),
        ModelFormat::Stl => validate_stl(bytes),
    }
}
fn validate_glb(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() < 20 || &bytes[0..4] != b"glTF" || word(bytes, 4) != 2 {
        return Err("导出数据不是 GLB 2.0 文件".into());
    }
    if word(bytes, 8) as usize != bytes.len() {
        return Err("GLB 文件长度与头部声明不一致".into());
    }
    let mut offset = 12usize;
    let mut json = None;
    let mut binary_length = None;
    while offset < bytes.len() {
        if bytes.len() - offset < 8 {
            return Err("GLB 数据块头部不完整".into());
        }
        let length = word(bytes, offset) as usize;
        let kind = word(bytes, offset + 4);
        let start = offset + 8;
        let end = start.checked_add(length).ok_or("GLB 数据块长度溢出")?;
        if length % 4 != 0 || end > bytes.len() {
            return Err("GLB 数据块长度无效或文件已截断".into());
        }
        match kind {
            0x4e4f534a if offset == 12 => {
                // Model metadata is small compared with vertex/image buffers. Bound JSON parsing too.
                if length > 32 * 1024 * 1024 {
                    return Err("GLB 元数据超过 32 MiB 限制".into());
                }
                let value: serde_json::Value = serde_json::from_slice(&bytes[start..end])
                    .map_err(|_| "GLB JSON 数据块无效")?;
                if value
                    .get("asset")
                    .and_then(|v| v.get("version"))
                    .and_then(|v| v.as_str())
                    != Some("2.0")
                {
                    return Err("GLB 缺少有效的 glTF 2.0 元数据".into());
                }
                json = Some(value);
            }
            0x004e4942 if json.is_some() && binary_length.is_none() => binary_length = Some(length),
            _ => return Err("GLB 数据块类型、顺序或数量无效".into()),
        }
        offset = end;
    }
    let json = json.ok_or("GLB 缺少 JSON 数据块")?;
    if let Some(buffers) = json.get("buffers") {
        let buffers = buffers.as_array().ok_or("GLB 缓冲区声明无效")?;
        if buffers.len() != 1 || buffers[0].get("uri").is_some() {
            return Err("GLB 导出必须包含单个内嵌缓冲区".into());
        }
        let declared = buffers[0]
            .get("byteLength")
            .and_then(|v| v.as_u64())
            .ok_or("GLB 缓冲区长度无效")?;
        let actual = binary_length.ok_or("GLB 缺少内嵌二进制数据")? as u64;
        if declared > actual || actual - declared > 3 {
            return Err("GLB 内嵌缓冲区长度不匹配".into());
        }
    } else if binary_length.is_some() {
        return Err("GLB 二进制数据缺少缓冲区声明".into());
    }
    Ok(())
}
fn validate_stl(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() < 84 {
        return Err("二进制 STL 头部不完整".into());
    }
    let triangles = word(bytes, 80) as usize;
    let expected = triangles.checked_mul(50).and_then(|n| n.checked_add(84));
    if triangles == 0 || expected != Some(bytes.len()) {
        return Err("二进制 STL 三角形数量与文件长度不一致，或模型为空".into());
    }
    for triangle in bytes[84..].chunks_exact(50) {
        for value in triangle[..48].chunks_exact(4) {
            if !f32::from_le_bytes(value.try_into().unwrap()).is_finite() {
                return Err("STL 含非有限的顶点坐标或法线".into());
            }
        }
    }
    Ok(())
}
fn export_filename(encoded: &str, format: ModelFormat) -> Result<String, String> {
    if encoded.len() > 4096 {
        return Err("导出文件名过长".into());
    }
    let mut bytes = Vec::with_capacity(encoded.len());
    let mut input = encoded.as_bytes().iter().copied();
    while let Some(value) = input.next() {
        if value == b'%' {
            let high = input.next().and_then(|v| (v as char).to_digit(16));
            let low = input.next().and_then(|v| (v as char).to_digit(16));
            bytes.push(match (high, low) {
                (Some(h), Some(l)) => (h * 16 + l) as u8,
                _ => return Err("导出文件名编码无效".into()),
            });
        } else {
            bytes.push(value);
        }
    }
    let decoded = String::from_utf8(bytes).map_err(|_| "导出文件名不是有效 UTF-8")?;
    let mut filename: String = decoded
        .chars()
        .filter(|c| !c.is_control() && !"/\\<>:\"|?*".contains(*c))
        .take(180)
        .collect();
    filename = filename.trim_matches([' ', '.']).to_string();
    if filename.is_empty() {
        filename = "assembly".into();
    }
    let extension = format!(".{}", format.extension());
    if !filename.to_ascii_lowercase().ends_with(&extension) {
        filename.push_str(&extension);
    }
    Ok(filename)
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn save_model_export(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<bool, String> {
    use tauri_plugin_dialog::DialogExt;
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .ok_or_else(|| format!("模型导出缺少元数据：{name}"))
    };
    let format = ModelFormat::parse(header("x-model-format")?)?;
    let filename = export_filename(header("x-model-filename")?, format)?;
    let tauri::ipc::InvokeBody::Raw(content) = request.body() else {
        return Err("模型导出需要原始二进制数据".into());
    };
    validate_size(content.len())?;
    let content = content.clone();
    tauri::async_runtime::spawn_blocking(move || {
        validate_model(&content, format)?;
        let selection = app
            .dialog()
            .file()
            .set_title("导出可见模型")
            .add_filter(
                if format == ModelFormat::Glb {
                    "GLB 模型"
                } else {
                    "二进制 STL 模型"
                },
                &[format.extension()],
            )
            .set_file_name(filename)
            .blocking_save_file();
        let Some(selection) = selection else {
            return Ok(false);
        };
        let path = selection.into_path().map_err(|error| error.to_string())?;
        if !path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case(format.extension()))
        {
            return Err(format!("请使用 .{} 文件扩展名保存模型", format.extension()));
        }
        // Write only the path confirmed by the system dialog, without changing its extension afterward.
        std::fs::write(path, content).map_err(|error| format!("模型保存失败：{error}"))?;
        Ok(true)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn glb() -> Vec<u8> {
        glb_with_json(br#"{"asset":{"version":"2.0"},"buffers":[{"byteLength":3}]}"#)
    }
    fn glb_with_json(json: &[u8]) -> Vec<u8> {
        let mut json = json.to_vec();
        while json.len() % 4 != 0 {
            json.push(b' ');
        }
        let length = 12 + 8 + json.len() + 8 + 4;
        let mut bytes = b"glTF".to_vec();
        bytes.extend(2u32.to_le_bytes());
        bytes.extend((length as u32).to_le_bytes());
        bytes.extend((json.len() as u32).to_le_bytes());
        bytes.extend(0x4e4f534au32.to_le_bytes());
        bytes.extend(json);
        bytes.extend(4u32.to_le_bytes());
        bytes.extend(0x004e4942u32.to_le_bytes());
        bytes.extend([1, 2, 3, 0]);
        bytes
    }
    fn stl() -> Vec<u8> {
        let mut bytes = vec![0; 134];
        bytes[80..84].copy_from_slice(&1u32.to_le_bytes());
        bytes[84 + 8..84 + 12].copy_from_slice(&1f32.to_le_bytes());
        bytes[84 + 24..84 + 28].copy_from_slice(&1f32.to_le_bytes());
        bytes[84 + 40..84 + 44].copy_from_slice(&1f32.to_le_bytes());
        bytes
    }
    #[test]
    fn validates_binary_glb_and_stl_without_text_conversion() {
        assert!(validate_model(&glb(), ModelFormat::Glb).is_ok());
        assert!(validate_model(&stl(), ModelFormat::Stl).is_ok());
        assert!(validate_model(&stl(), ModelFormat::Glb).is_err());
    }
    #[test]
    fn enforces_byte_limit_before_copying_binary_payloads() {
        assert!(validate_size(0).is_err());
        assert!(validate_size(MAX_MODEL_BYTES).is_ok());
        assert!(validate_size(MAX_MODEL_BYTES + 1).is_err());
    }
    #[test]
    fn rejects_glb_truncation_bad_versions_chunks_and_external_buffers() {
        let original = glb();
        for length in [0, 11, 19, original.len() - 1] {
            assert!(validate_model(&original[..length], ModelFormat::Glb).is_err());
        }
        let mut bytes = original.clone();
        bytes[4] = 1;
        assert!(validate_glb(&bytes).is_err());
        let mut bytes = original.clone();
        bytes[12..16].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(validate_glb(&bytes).is_err());
        let mut bytes = original;
        bytes[20] = b'!';
        assert!(validate_glb(&bytes).is_err());
        assert!(validate_glb(&glb_with_json(
            br#"{"asset":{"version":"2.0"},"buffers":[{"byteLength":5}]}"#
        ))
        .is_err());
        assert!(validate_glb(&glb_with_json(
            br#"{"asset":{"version":"2.0"},"buffers":[{"byteLength":3,"uri":"remote.bin"}]}"#
        ))
        .is_err());
    }
    #[test]
    fn rejects_stl_count_mismatch_truncation_and_nonfinite_values() {
        let original = stl();
        assert!(validate_model(&original[..133], ModelFormat::Stl).is_err());
        let mut bytes = original.clone();
        bytes[80..84].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(validate_stl(&bytes).is_err());
        let mut bytes = original;
        bytes[96..100].copy_from_slice(&f32::NAN.to_le_bytes());
        assert!(validate_stl(&bytes).is_err());
    }
    #[test]
    fn decodes_unicode_filename_and_never_accepts_a_renderer_path() {
        assert_eq!(
            export_filename("%E6%A8%A1%E5%9E%8B.glb", ModelFormat::Glb).unwrap(),
            "模型.glb"
        );
        assert_eq!(
            export_filename("..%2F..%2Fpart", ModelFormat::Stl).unwrap(),
            "part.stl"
        );
        assert!(export_filename("bad%2", ModelFormat::Glb).is_err());
        assert!(export_filename("%FF", ModelFormat::Glb).is_err());
        assert!(ModelFormat::parse("obj").is_err());
    }
}
