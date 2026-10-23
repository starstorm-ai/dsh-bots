// swift-tools-version: 6.0
import PackageDescription
let package = Package(name: "DSHBots", platforms: [.iOS(.v18), .macOS(.v14)], products: [.library(name: "DSHBotsCore", targets: ["DSHBotsCore"])], targets: [
    .systemLibrary(name: "CSQLite"),
    .target(name: "DSHBotsCore", dependencies: ["CSQLite"]),
    .testTarget(name: "DSHBotsCoreTests", dependencies: ["DSHBotsCore"], resources: [.copy("Fixtures")])
])
