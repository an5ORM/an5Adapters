// Gradle needs this to treat the runtime as its own build rather than as part of whatever
// happens to be checked out next to it. Only the name and repositories: the build itself
// lives in build.gradle.kts.
rootProject.name = "an5-adapters-kotlin"

dependencyResolutionManagement {
    repositories {
        mavenCentral()
    }
}