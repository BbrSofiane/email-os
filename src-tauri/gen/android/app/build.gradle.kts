import java.util.Properties
import java.io.FileInputStream
import groovy.json.JsonSlurper

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

val repositoryVersion = (JsonSlurper().parse(file("../../../tauri.conf.json")) as Map<*, *>)["version"] as String

val releaseInputs = listOf(
    "ANDROID_KEYSTORE_PATH", "ANDROID_KEYSTORE_PASSWORD",
    "ANDROID_KEY_ALIAS", "ANDROID_KEY_PASSWORD", "ANDROID_VERSION_CODE"
).associateWith { System.getenv(it) }
val releaseCode = releaseInputs["ANDROID_VERSION_CODE"]?.toIntOrNull()

gradle.taskGraph.whenReady {
    if (allTasks.any { it.project == project && it.name.contains("Release", ignoreCase = true) }) {
        require(releaseInputs.values.all { !it.isNullOrBlank() }) { "Release requires all Android signing inputs and ANDROID_VERSION_CODE" }
        require(releaseCode != null && releaseCode in 1..2100000000) { "ANDROID_VERSION_CODE must be an integer from 1 to 2100000000" }
        require(file(releaseInputs.getValue("ANDROID_KEYSTORE_PATH")!!).isFile) { "Release keystore does not exist" }
        require(repositoryVersion.isNotBlank()) { "Release requires the repository version name" }
    }
}

android {
    compileSdk = 35
    ndkVersion = "27.2.12479018"
    namespace = "dev.exedev.emailos"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "dev.exedev.emailos"
        minSdk = 24
        targetSdk = 35
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = repositoryVersion
    }
    signingConfigs {
        create("release") {
            releaseInputs["ANDROID_KEYSTORE_PATH"]?.let { storeFile = file(it) }
            storePassword = releaseInputs["ANDROID_KEYSTORE_PASSWORD"]
            if (storeFile?.isFile == true && storePassword != null) {
                // Probe the container itself, not its filename. Java supports both formats.
                storeType = FileInputStream(storeFile).use { input ->
                    val magic = ByteArray(4)
                    require(input.read(magic) == 4) { "Invalid keystore" }
                    if (magic.contentEquals(byteArrayOf(0xfe.toByte(), 0xed.toByte(), 0xfe.toByte(), 0xed.toByte()))) "JKS" else "PKCS12"
                }
            }
            keyAlias = releaseInputs["ANDROID_KEY_ALIAS"]
            keyPassword = releaseInputs["ANDROID_KEY_PASSWORD"]
        }
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            signingConfig = signingConfigs.getByName("release")
            isMinifyEnabled = true
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
}

androidComponents {
    onVariants(selector().withBuildType("release")) { variant ->
        if (releaseCode != null) {
            variant.outputs.forEach { it.versionCode.set(releaseCode) }
        }
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("com.google.android.gms:play-services-auth:21.4.0")
    implementation("androidx.webkit:webkit:1.6.1")
    implementation("androidx.appcompat:appcompat:1.6.1")
    implementation("com.google.android.material:material:1.8.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")
