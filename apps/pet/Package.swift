// swift-tools-version:5.9
import PackageDescription

let package = Package(
  name: "LobstahPet",
  platforms: [.macOS(.v13)],
  targets: [
    .executableTarget(
      name: "LobstahPet",
      path: "Sources/LobstahPet",
      resources: [.process("Resources")]
    )
  ]
)
