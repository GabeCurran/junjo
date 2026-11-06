plugins {
    `java-library`
    `maven-publish`
    signing
}

group = "io.junjo"
version = "0.1.0"
description = "Java SDK for Junjo: groups, roles, permissions, bans and linked identities over REST and Server-Sent Events."

repositories {
    mavenCentral()
}

dependencies {
    api("com.google.code.gson:gson:2.11.0")

    testImplementation(platform("org.junit:junit-bom:5.11.4"))
    testImplementation("org.junit.jupiter:junit-jupiter")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

java {
    withSourcesJar()
    withJavadocJar()
}

tasks.withType<JavaCompile>().configureEach {
    options.release.set(21)
    options.encoding = "UTF-8"
    options.compilerArgs.addAll(listOf("-Xlint:all,-serial,-processing", "-Werror"))
}

tasks.withType<Javadoc>().configureEach {
    options.encoding = "UTF-8"
    (options as StandardJavadocDocletOptions).apply {
        addStringOption("Xdoclint:all,-missing", "-quiet")
        addBooleanOption("html5", true)
    }
}

tasks.jar {
    manifest {
        attributes(
            "Implementation-Title" to "junjo-sdk",
            "Implementation-Version" to project.version,
        )
    }
}

tasks.test {
    useJUnitPlatform()
    // The conformance vectors are shared with the server; tests read them in place.
    systemProperty(
        "junjo.conformance.vectors",
        layout.projectDirectory.file("../shared/conformance/permission-vectors.json").asFile.absolutePath,
    )
    // A hung socket or thread must fail a test, not stall the build.
    systemProperty("junit.jupiter.execution.timeout.default", "60 s")
    systemProperty("junit.jupiter.execution.timeout.mode", "enabled")
    testLogging {
        events("failed", "skipped")
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
        showStandardStreams = false
    }
    addTestListener(object : TestListener {
        override fun beforeSuite(suite: TestDescriptor) {}
        override fun beforeTest(testDescriptor: TestDescriptor) {}
        override fun afterTest(testDescriptor: TestDescriptor, result: TestResult) {}
        override fun afterSuite(suite: TestDescriptor, result: TestResult) {
            if (suite.parent == null) {
                println(
                    "Tests: ${result.testCount} run, ${result.successfulTestCount} passed, " +
                        "${result.failedTestCount} failed, ${result.skippedTestCount} skipped",
                )
            }
        }
    })
}

publishing {
    publications {
        create<MavenPublication>("maven") {
            artifactId = "junjo-sdk"
            from(components["java"])
            pom {
                name.set("Junjo Java SDK")
                description.set(project.description)
                url.set("https://junjo.io")
                licenses {
                    license {
                        name.set("MIT License")
                        url.set("https://opensource.org/licenses/MIT")
                    }
                }
                developers {
                    developer {
                        id.set("junjo")
                        name.set("Junjo")
                        url.set("https://junjo.io")
                    }
                }
                scm {
                    url.set("https://github.com/GabeCurran/junjo")
                    connection.set("scm:git:https://github.com/GabeCurran/junjo.git")
                    developerConnection.set("scm:git:ssh://git@github.com/GabeCurran/junjo.git")
                }
            }
        }
    }
    repositories {
        // A local directory repository, for inspecting the exact artifacts a release would upload.
        maven {
            name = "staging"
            url = uri(layout.buildDirectory.dir("staging-repo"))
        }
        val centralUser = providers.environmentVariable("JUNJO_CENTRAL_USERNAME").orNull
        val centralPassword = providers.environmentVariable("JUNJO_CENTRAL_PASSWORD").orNull
        if (centralUser != null && centralPassword != null) {
            maven {
                name = "central"
                url = uri("https://ossrh-staging-api.central.sonatype.com/service/local/staging/deploy/maven2/")
                credentials {
                    username = centralUser
                    password = centralPassword
                }
            }
        }
    }
}

signing {
    // Signing is active only when a key is supplied, so local builds never need one.
    val signingKey = providers.environmentVariable("JUNJO_SIGNING_KEY").orNull
    val signingPassword = providers.environmentVariable("JUNJO_SIGNING_PASSWORD").orNull
    isRequired = signingKey != null
    if (signingKey != null) {
        useInMemoryPgpKeys(signingKey, signingPassword)
        sign(publishing.publications["maven"])
    }
}
