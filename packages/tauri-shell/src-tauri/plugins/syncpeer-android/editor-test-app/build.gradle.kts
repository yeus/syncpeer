plugins {
    id("com.android.application") version "8.11.0"
    id("org.jetbrains.kotlin.android") version "1.9.25"
}

android {
    namespace = "dev.syncpeer.synthetic.editor"
    compileSdk = 36

    defaultConfig {
        applicationId = "dev.syncpeer.synthetic.editor"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "1"
    }

    buildTypes {
        release { isMinifyEnabled = false }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    kotlinOptions { jvmTarget = "1.8" }
}
