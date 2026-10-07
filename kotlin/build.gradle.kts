plugins {
    kotlin("jvm") version "2.0.21"
    `java-library`
    `maven-publish`
    signing
}

// Gradle rather than Maven because Kotlin on Android is built with Gradle, and a runtime a
// phone app cannot resolve is not a mobile runtime. Maven consumers can still use the
// published Maven coordinates; this module publishes both.
group = "io.github.an5orm"
version = "0.2.11"

repositories {
    // The Java runtime is a sibling checkout, not a published artifact during development:
    // `mvn -f java/pom.xml install` puts it in ~/.m2 and this resolves it from there. Every
    // other dependency still comes from Central, so a consumer without a local install is
    // unaffected.
    mavenLocal()
    mavenCentral()
}

dependencies {
    // The Java adapter is the implementation; this module is the Kotlin surface over it.
    // One SQL builder and one set of dialect rules, so a where tree cannot mean one thing in
    // Java and another in Kotlin.
    api("io.github.an5orm:an5-adapters-java:${version}")

    // `api`, not `implementation`: a row's accessors return stdlib types, so consumers see
    // them in their own signatures.
    api(kotlin("stdlib"))

    // Tests run against the same SQLite the other runtimes use, which needs no licence and
    // runs on every platform the workspace builds on.
    testImplementation("org.xerial:sqlite-jdbc:3.46.1.3")
}

java {
    // Java 8 bytecode: Android desugars Java 8 but not newer language features, so a runtime
    // compiled to a newer target cannot be used on a device.
    sourceCompatibility = JavaVersion.VERSION_1_8
    targetCompatibility = JavaVersion.VERSION_1_8
    // Sources are required by Maven Central; the javadoc jar is empty because the sources are
    // Kotlin and only a Kotlin-aware generator would fill it.
    withSourcesJar()
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_1_8)
    }
}

sourceSets {
    named("main") { kotlin.srcDir("src/main/kotlin") }
    named("test") { kotlin.srcDir("src/test/kotlin") }
}

// The runtime's tests are a `main()` program, not JUnit classes, so they need a runner
// rather than a test framework: `useJUnitPlatform()` with no engine on the classpath makes
// the launcher refuse to start, and an engine added to make it start would find zero tests
// and pass without running anything. `smoke` runs the program, and `check` — so `build` —
// depends on it.
val smoke = tasks.register<JavaExec>("smoke") {
    group = "verification"
    description = "Runs the Kotlin runtime smoke against a real SQLite database."
    classpath = sourceSets.getByName("test").runtimeClasspath
    mainClass.set("an5.adapters.An5Smoke")
}

tasks.named("check") {
    dependsOn(smoke)
}

tasks.test {
    // An5Smoke is executed by `smoke`; there is nothing here for a test framework to find.
    testLogging {
        events("passed", "failed", "skipped")
    }
}

val javadocJar = tasks.register<Jar>("javadocJar") {
    archiveClassifier.set("javadoc")
}

publishing {
    publications {
        create<MavenPublication>("maven") {
            from(components["java"])
            artifact(javadocJar)
            pom {
                name.set("AN5 ORM Kotlin adapter")
                description.set(
                    "Kotlin runtime for AN5 ORM: dialect-aware CRUD, relation eager loading " +
                        "and vector search over the AN5 Java adapter.",
                )
                url.set("https://github.com/an5ORM/an5Adapters")
                licenses {
                    license {
                        name.set("MIT License")
                        url.set("https://opensource.org/licenses/MIT")
                    }
                }
                developers {
                    developer {
                        name.set("AN5 ORM")
                        organization.set("AN5")
                        url.set("https://github.com/an5ORM")
                    }
                }
                scm {
                    connection.set("scm:git:https://github.com/an5ORM/an5Adapters.git")
                    developerConnection.set("scm:git:ssh://git@github.com/an5ORM/an5Adapters.git")
                    url.set("https://github.com/an5ORM/an5Adapters")
                }
            }
        }
    }
    repositories {
        // The Sonatype Central Portal accepts legacy OSSRH clients on this endpoint, so Gradle
        // uploads reach the same repository as the Maven side's central-publishing plugin.
        // Credentials come from the environment; `publishToMavenLocal` never touches them.
        maven {
            name = "central"
            url = uri(
                System.getenv("MAVEN_CENTRAL_URL")
                    ?: "https://ossrh-staging-api.central.sonatype.com/service/local/staging/deploy/maven2/",
            )
            credentials {
                username = System.getenv("MAVEN_CENTRAL_USERNAME")
                password = System.getenv("MAVEN_CENTRAL_TOKEN")
            }
        }
    }
}

// Signing is conditional: a checkout without a key still runs `publishToMavenLocal` and
// `build`, and only a release machine supplies MAVEN_GPG_PRIVATE_KEY.
signing {
    val signingKey = System.getenv("MAVEN_GPG_PRIVATE_KEY")
    if (!signingKey.isNullOrBlank()) {
        useInMemoryPgpKeys(signingKey, System.getenv("MAVEN_GPG_PASSPHRASE"))
        sign(publishing.publications)
    }
}