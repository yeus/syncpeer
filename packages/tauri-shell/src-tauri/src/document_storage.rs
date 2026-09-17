//! JNI transport for the same byte-storage implementation used by Tauri commands.
use crate::replica_storage::{dispatch, ReplicaRoots, ReplicaStorageRequest};
use jni::{
    objects::{JObject, JString},
    sys::jstring,
    JNIEnv,
};

#[no_mangle]
pub extern "system" fn Java_dev_syncpeer_plugin_android_DocumentByteStorage_initialize(
    mut env: JNIEnv,
    object: JObject,
    metadata_path: JString,
    metadata_key: JString,
) {
    // The private Java field is owned by this adapter, initialized once, and all
    // access is serialized by the Kotlin instance. jni stores a Mutex<T> in it.
    let result = (|| -> Result<(), String> {
        let path: String = env
            .get_string(&metadata_path)
            .map_err(|e| e.to_string())?
            .into();
        if !std::path::Path::new(&path).is_absolute() {
            return Err("Invalid metadata directory".into());
        }
        let encoded: String = env.get_string(&metadata_key).map_err(|e| e.to_string())?.into();
        if encoded.len() != 64 { return Err("Invalid metadata key".into()); }
        let mut key = [0u8; 32];
        for (index, byte) in key.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&encoded[index * 2..index * 2 + 2], 16)
                .map_err(|_| "Invalid metadata key".to_string())?;
        }
        let roots = ReplicaRoots::new(path.into(), key);
        key.fill(0);
        unsafe { env.set_rust_field(&object, "nativeHandle", roots) }.map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = env.throw_new(
            "java/lang/IllegalStateException",
            "Document storage unavailable",
        );
    }
}

#[no_mangle]
pub extern "system" fn Java_dev_syncpeer_plugin_android_DocumentByteStorage_request(
    mut env: JNIEnv,
    object: JObject,
    input: JString,
) -> jstring {
    let result = (|| -> Result<serde_json::Value, String> {
        let json: String = env.get_string(&input).map_err(|e| e.to_string())?.into();
        if json.len() > 2 * 1024 * 1024 {
            return Err("Oversized storage request".into());
        }
        let request: ReplicaStorageRequest =
            serde_json::from_str(&json).map_err(|e| e.to_string())?;
        let mut roots =
            unsafe { env.get_rust_field::<_, _, ReplicaRoots>(&object, "nativeHandle") }
                .map_err(|e| e.to_string())?;
        dispatch(&mut roots, request)
    })();
    let response = match result {
        Ok(value) => serde_json::json!({"result": value}),
        Err(_) => serde_json::json!({"error": "Document storage operation failed"}),
    };
    match env.new_string(response.to_string()) {
        Ok(value) => value.into_raw(),
        Err(_) => {
            let _ = env.throw_new(
                "java/lang/IllegalStateException",
                "Document storage response unavailable",
            );
            std::ptr::null_mut()
        }
    }
}

#[no_mangle]
pub extern "system" fn Java_dev_syncpeer_plugin_android_DocumentByteStorage_dispose(
    mut env: JNIEnv,
    object: JObject,
) {
    let _ = unsafe { env.take_rust_field::<_, _, ReplicaRoots>(&object, "nativeHandle") };
}
