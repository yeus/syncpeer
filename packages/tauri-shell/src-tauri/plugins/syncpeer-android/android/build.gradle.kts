plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "dev.syncpeer.plugin.android"
    compileSdk = 36

    defaultConfig {
        minSdk = 21

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        testInstrumentationRunnerArguments["requireDocumentRuntime"] =
            (providers.environmentVariable("SYNCPEER_REQUIRE_DOCUMENT_RUNTIME").orNull == "1").toString()
        consumerProguardFiles("consumer-rules.pro")
    }

    testOptions {
        targetSdk = 36
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("generated/document-runtime/assets"))
    sourceSets["androidTest"].jniLibs.srcDir(projectDir.resolve("../../../gen/android/app/src/main/jniLibs"))
}

val workspaceRoot = projectDir.resolve("../../../../../..")
val buildDocumentRuntime by tasks.registering(Exec::class) {
    workingDir(workspaceRoot)
    commandLine("node", "scripts/build-document-runtime.mjs")
    inputs.files(fileTree(workspaceRoot.resolve("packages/core/src")))
    inputs.files(fileTree(workspaceRoot.resolve("packages/core/vendor")))
    inputs.files(fileTree(workspaceRoot.resolve("packages/tauri-shell/src")))
    inputs.file(workspaceRoot.resolve("scripts/build-document-runtime.mjs"))
    inputs.file(workspaceRoot.resolve("package-lock.json"))
    outputs.dir(layout.buildDirectory.dir("generated/document-runtime/assets"))
}
tasks.named("preBuild").configure { dependsOn(buildDocumentRuntime) }

dependencies {
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    implementation("androidx.javascriptengine:javascriptengine:1.1.0") {
        // This artifact is Java-only (no kotlin.* references). Keep Tauri's
        // Kotlin toolchain: its 1.9 compiler cannot read the unused 2.1 stdlib.
        exclude(group = "org.jetbrains.kotlin", module = "kotlin-stdlib")
    }
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("androidx.documentfile:documentfile:1.0.1")
    implementation(project(":tauri-android"))
}
