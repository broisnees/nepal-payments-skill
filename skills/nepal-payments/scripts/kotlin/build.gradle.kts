import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    kotlin("jvm") version "2.4.21"
}

// No toolchain: CI runs this build on JDK 17 and 21. Bytecode and JDK API usage are pinned to 17 instead.
java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
        freeCompilerArgs.add("-Xjdk-release=17")
        allWarningsAsErrors.set(true)
    }
}

// Live sandbox check (network). Not part of `test`; run with `./gradlew sandbox`.
val sandbox: SourceSet = sourceSets.create("sandbox") {
    compileClasspath += sourceSets.main.get().output
    runtimeClasspath += sourceSets.main.get().output
}
// Sandbox code may use the adapters' internal helpers.
kotlin.target.compilations.getByName("sandbox").associateWith(kotlin.target.compilations.getByName("main"))
configurations[sandbox.implementationConfigurationName].extendsFrom(configurations.implementation.get())
configurations[sandbox.runtimeOnlyConfigurationName].extendsFrom(configurations.runtimeOnly.get())

dependencies {
    // Main code: kotlin-stdlib (added by the plugin) + the JDK only.
    testImplementation(kotlin("test-junit5"))
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.9.0")
}

tasks.test {
    useJUnitPlatform()
    // Compile (never run) the sandbox check with the tests so CI catches breakage.
    dependsOn(tasks.named(sandbox.classesTaskName))
    testLogging {
        events("failed")
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
    }
}

tasks.register<JavaExec>("sandbox") {
    group = "verification"
    description = "Live sandbox smoke test against eSewa (rc) and Fonepay (dev). Set KHALTI_SECRET_KEY to include Khalti."
    classpath = sandbox.runtimeClasspath
    mainClass.set("np.payments.SandboxKt")
}
