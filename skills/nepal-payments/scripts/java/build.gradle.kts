import org.gradle.api.tasks.testing.logging.TestExceptionFormat
import org.gradle.api.tasks.testing.logging.TestLogEvent

plugins {
    `java-library`
}

group = "np.payments"
version = "1.0.0"
description = "Adapters for Nepali payment providers (eSewa, Khalti, Fonepay, connectIPS, CyberSource, NPS, IME Pay, NEPALPAY QR). JDK only."

repositories {
    mavenCentral()
}

dependencies {
    // Zero runtime dependencies. JUnit Jupiter is the only test dependency.
    testImplementation(platform("org.junit:junit-bom:5.14.4"))
    testImplementation("org.junit.jupiter:junit-jupiter")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.withType<JavaCompile>().configureEach {
    options.release = 17
    options.encoding = "UTF-8"
    options.compilerArgs.addAll(listOf("-Xlint:all", "-Werror"))
}

tasks.test {
    useJUnitPlatform()
    testLogging {
        events(TestLogEvent.FAILED, TestLogEvent.SKIPPED)
        exceptionFormat = TestExceptionFormat.FULL
    }
}

// Live provider sandboxes (network). Not part of `test`: ./gradlew sandbox
tasks.register<JavaExec>("sandbox") {
    group = "verification"
    description = "Live sandbox smoke test: eSewa (form, status, Intent) + Fonepay dev redirect; Khalti when KHALTI_SECRET_KEY is set."
    classpath = sourceSets["test"].runtimeClasspath
    mainClass = "np.payments.SandboxCheck"
}
