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
) {
    // The private Java field is owned by this adapter, initialized once, and all
    // access is serialized by the Kotlin instance. jni stores a Mutex<T> in it.
    if unsafe { env.set_rust_field(&object, "nativeHandle", ReplicaRoots::default()) }.is_err() {
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
