// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "ExpoLocalInference",
  platforms: [.iOS(.v16)],
  products: [
    .library(name: "ExpoLocalInference", targets: ["ExpoLocalInference"]),
  ],
  dependencies: [
    .package(url: "https://github.com/ml-explore/mlx-swift.git", from: "0.21.0"),
    .package(url: "https://github.com/ml-explore/mlx-swift-examples.git", from: "1.0.0"),
  ],
  targets: [
    .target(
      name: "ExpoLocalInference",
      dependencies: [
        .product(name: "MLX", package: "mlx-swift"),
        .product(name: "MLXNN", package: "mlx-swift"),
        .product(name: "MLXLLM", package: "mlx-swift-examples"),
        .product(name: "MLXLMCommon", package: "mlx-swift-examples"),
      ]
    ),
  ]
)
