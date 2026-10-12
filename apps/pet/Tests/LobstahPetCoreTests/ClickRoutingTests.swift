import Foundation
import XCTest
@testable import LobstahPetCore

final class ClickRoutingTests: XCTestCase {
  func testAppAttemptSuccessAndFallback() {
    let glass = URL(string: "http://127.0.0.1:63169")!
    for kind in ["report", "decision"] {
      for succeeds in [true, false] {
        var item = AttentionItem(id: "a", verb: kind, note: nil, key: "\(kind):a", kind: kind)
        item.petOpen = "app"
        var actions: [String] = []
        clickAttentionItem(item, glass: glass,
          open: { _ in actions.append("tab") }, focusHelm: { _ in XCTFail("app never focuses helm") },
          showApp: { target, otherwise in
            XCTAssertEqual(target, item.glassTarget(glass: glass))
            actions.append("app")
            if !succeeds { otherwise() }
          }, acknowledge: { _ in actions.append("ack") })
        XCTAssertEqual(actions, succeeds ? ["app", "ack"] : ["app", "tab", "ack"])
      }
    }
  }

  func testInstalledChromeGlassUsesMetadataAndExactOrigin() {
    let glass = URL(string: "http://127.0.0.1:63169")!
    var info: [String: Any] = ["CrBundleIdentifier": "com.google.Chrome", "CFBundleIdentifier": "com.google.Chrome.app.abc", "CrAppModeShortcutURL": "http://127.0.0.1:63169/"]
    XCTAssertTrue(isInstalledChromeGlass(info, glass: glass))
    for bad in ["http://127.0.0.1:4949/", "http://localhost:63169/", "https://127.0.0.1:63169/", "http://127.0.0.1:63169/elsewhere", "http://user@127.0.0.1:63169/"] {
      info["CrAppModeShortcutURL"] = bad
      XCTAssertFalse(isInstalledChromeGlass(info, glass: glass))
    }
    info["CrAppModeShortcutURL"] = glass.absoluteString
    info["CrBundleIdentifier"] = "com.apple.Safari"
    XCTAssertFalse(isInstalledChromeGlass(info, glass: glass))
    XCTAssertEqual(glassShowArguments("#prs", port: 63169, installedOnly: true), ["glass", "show", "#prs", "--port", "63169", "--json", "--app"])
  }
  func testConfiguredRoutesForReportsAndDecisions() {
    let glass = URL(string: "http://127.0.0.1:63169")!
    for kind in ["report", "decision"] {
      for route in ["tab", "app", "helm"] {
        var item = AttentionItem(id: "a", verb: kind, note: nil, key: "\(kind):a", kind: kind)
        item.petOpen = route
        var actions: [String] = []
        clickAttentionItem(item, glass: glass, helmLive: true,
          open: { actions.append("open:\($0.absoluteString)") },
          focusHelm: { actions.append("helm:\($0.absoluteString)") },
          showGlass: { _, _ in XCTFail("configured clicks never select a browser tab") },
          acknowledge: { _ in actions.append("ack") })
        XCTAssertEqual(actions, ["\(route == "helm" ? "helm" : "open"):\(item.glassTarget(glass: glass)!.url.absoluteString)", "ack"])
      }
    }
  }

  func testPRIgnoresReportDecisionRouting() {
    for route in ["tab", "app", "helm"] {
      var item = AttentionItem(id: "a", verb: "pr:ready", note: nil, kind: "pr:ready", prUrl: "https://github.com/a/b/pull/1")
      item.petOpen = route
      var opened: URL?
      clickAttentionItem(item, glass: URL(string: "http://127.0.0.1:63169")!,
        open: { opened = $0 }, focusHelm: { _ in XCTFail("PRs never route to helm") }, acknowledge: { _ in })
      XCTAssertEqual(opened?.absoluteString, item.prUrl)
    }
  }
}
