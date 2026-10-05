// swift-tools-version: 5.9
import PackageDescription

// The product is `An5Adapters`. A consumer refers to it as
// `.product(name: "An5Adapters", package: "an5Adapters")` when it depends on this repository
// by URL — SwiftPM derives the package identity from the URL's last path component. A
// `.package(path:)` dependency takes the checkout's directory name instead, so from a local
// clone the identity is `swift` and that argument must match.
let package = Package(
    name: "An5Adapters",
    products: [
        .library(name: "An5Adapters", targets: ["An5Adapters"])
    ],
    targets: [
        // The system SQLite, reached through a shim header rather than a copy of the C API.
        // SQLite is what the other mobile-facing clients read and write on device, and the
        // runtime is always present on iOS, tvOS, watchOS, macOS and Android.
        .systemLibrary(name: "CSQLite", path: "Sources/CSQLite"),
        .target(name: "An5Adapters", dependencies: ["CSQLite"]),
        .testTarget(name: "An5AdaptersTests", dependencies: ["An5Adapters"]),
    ]
)