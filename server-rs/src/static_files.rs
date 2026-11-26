use axum::body::Body;
use axum::http::{header, HeaderMap, Method, Response, StatusCode};
use flate2::write::GzEncoder;
use flate2::Compression;
use std::collections::HashMap;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::RwLock;
use std::time::SystemTime;

struct CachedGzip {
    mtime: SystemTime,
    gzipped: Vec<u8>,
    content_type: &'static str,
}

pub struct StaticFileServer {
    pub public_root: PathBuf,
    pub three_root: PathBuf,
    gzip_cache: RwLock<HashMap<PathBuf, CachedGzip>>,
}

impl StaticFileServer {
    pub fn new(project_root: &Path) -> Self {
        Self {
            public_root: project_root.join("public"),
            three_root: project_root.join("node_modules").join("three"),
            gzip_cache: RwLock::new(HashMap::new()),
        }
    }

    pub fn safe_resolve(root: &Path, rel: &str) -> Option<PathBuf> {
        let mut resolved = root.to_path_buf();
        for comp in Path::new(rel.trim_start_matches('/')).components() {
            match comp {
                Component::Normal(seg) => resolved.push(seg),
                Component::CurDir => {}
                Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
            }
        }
        Some(resolved)
    }

    pub async fn serve_file(
        &self,
        method: &Method,
        req_headers: &HeaderMap,
        full_path: &Path,
        cache_control: &'static str,
    ) -> Option<Response<Body>> {
        let meta = tokio::fs::metadata(full_path).await.ok()?;
        if !meta.is_file() {
            return None;
        }

        let ext = full_path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .unwrap_or_default();

        let content_type = mime_for_ext(&ext);
        let accepts_gzip = req_headers
            .get(header::ACCEPT_ENCODING)
            .and_then(|v| v.to_str().ok())
            .map(|v| v.contains("gzip"))
            .unwrap_or(false);

        if accepts_gzip && is_compressible(&ext) {
            let mtime = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
            let cached = {
                let guard = self.gzip_cache.read().ok()?;
                guard.get(full_path).and_then(|e| {
                    if e.mtime == mtime {
                        Some((e.gzipped.clone(), e.content_type))
                    } else {
                        None
                    }
                })
            };

            let (gz_bytes, ct) = if let Some(hit) = cached {
                hit
            } else {
                let raw = tokio::fs::read(full_path).await.ok()?;
                let mut encoder = GzEncoder::new(Vec::new(), Compression::new(6));
                encoder.write_all(&raw).ok()?;
                let gz = encoder.finish().ok()?;
                if let Ok(mut guard) = self.gzip_cache.write() {
                    guard.insert(
                        full_path.to_path_buf(),
                        CachedGzip {
                            mtime,
                            gzipped: gz.clone(),
                            content_type,
                        },
                    );
                }
                (gz, content_type)
            };

            let len = gz_bytes.len();
            let body = if *method == Method::HEAD {
                Body::empty()
            } else {
                Body::from(gz_bytes)
            };
            return Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, ct)
                .header(header::CONTENT_ENCODING, "gzip")
                .header(header::VARY, "Accept-Encoding")
                .header(header::CACHE_CONTROL, cache_control)
                .header(header::CONTENT_LENGTH, len)
                .body(body)
                .ok();
        }

        let raw = if *method == Method::HEAD {
            Vec::new()
        } else {
            tokio::fs::read(full_path).await.ok()?
        };
        let len = meta.len();
        Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, content_type)
            .header(header::CACHE_CONTROL, cache_control)
            .header(header::CONTENT_LENGTH, len)
            .body(Body::from(raw))
            .ok()
    }
}

fn is_compressible(ext: &str) -> bool {
    matches!(ext, "js" | "mjs" | "css" | "html" | "json" | "obj" | "svg")
}

fn mime_for_ext(ext: &str) -> &'static str {
    match ext {
        "js" | "mjs" => "application/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "html" => "text/html; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "obj" => "text/plain; charset=utf-8",
        "svg" => "image/svg+xml; charset=utf-8",
        "png" => "image/png",
        "glb" => "model/gltf-binary",
        "ogg" => "audio/ogg",
        "otf" => "font/otf",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}
