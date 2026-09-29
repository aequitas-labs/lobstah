// swift-tools-version:5.9
import PackageDescription

let package = Package(
  name: "LobstahPet",
  platforms: [.macOS(.v13)],
  targets: [
    // Everything that runs without a window: child processes, the
    // attention read, the state file, the log. Tested on its own.
    .target(
      name: "LobstahPetCore",
      path: "Sources/LobstahPetCore"
    ),
    .executableTarget(
      name: "LobstahPet",
      dependencies: ["LobstahPetCore"],
      path: "Sources/LobstahPet",
      resources: [.process("Resources")]
    ),
    .testTarget(
      name: "LobstahPetCoreTests",
      dependencies: ["LobstahPetCore"],
      path: "Tests/LobstahPetCoreTests"
    ),
  ]
)
