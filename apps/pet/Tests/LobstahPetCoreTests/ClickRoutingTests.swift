import Foundation
import XCTest
@testable import LobstahPetCore

final class ClickRoutingTests: XCTestCase {
  func testWharfReportsAndDecisionsUseTheirOwnGlassUnderEveryRoute() {
    let local = URL(string: "http://127.0.0.1:63169")!
    for kind in ["report", "decision"] {
      for route in ["tab", "app", "helm"] {
        for delivered in [true, false] {
          let url = URL(string: "https://glass.example/#\(kind)/remote")!
          var item = AttentionItem(id: "remote", verb: kind, note: nil, key: "\(kind):remote", kind: kind, grounds: "away", glass: url.absoluteString)
          item.petOpen = route
          var actions: [String] = []
          clickAttentionItem(item, glass: local, helmLive: true,
            open: { XCTAssertEqual($0, url); actions.append("tab") },
            focusHelm: { XCTAssertEqual($0, url); actions.append("helm") },
            showGlass: { _, _ in XCTFail("hosted clicks never move a local page") },
            showApp: { target, otherwise in
              XCTAssertEqual(target, GlassTarget(hash: "#\(kind)/remote", url: url))
              XCTAssertFalse(usesLocalGlassShow(target, local: local))
              actions.append("app")
              if !delivered { otherwise() }
            }, acknowledge: { _ in actions.append("ack") })
          let expected = route == "app" ? (delivered ? ["app", "ack"] : ["app", "tab", "ack"]) : [route, "ack"]
          XCTAssertEqual(actions, expected)
        }
      }
    }
  }

  func testInstalledAppMatchesHostedOriginAndLocalShowStaysLocal() {
    let hosted = URL(string: "https://glass.example/#report/r")!
    var info: [String: Any] = ["CrBundleIdentifier": "com.google.Chrome", "CFBundleIdentifier": "com.google.Chrome.app.abc", "CrAppModeShortcutURL": "https://glass.example/"]
    XCTAssertTrue(isInstalledChromeGlass(info, glass: hosted))
    for other in ["https://other.example/", "http://glass.example/", "https://glass.example:8443/", "http://127.0.0.1:63169/", "https://user@glass.example/", "https://glass.example/?redirect=elsewhere"] {
      info["CrAppModeShortcutURL"] = other
      XCTAssertFalse(isInstalledChromeGlass(info, glass: hosted))
    }
    let local = URL(string: "http://127.0.0.1:63169")!
    XCTAssertTrue(usesLocalGlassShow(GlassTarget(hash: "#report/r", url: local.appendingPathComponent("report/r")), local: local))
    XCTAssertFalse(usesLocalGlassShow(GlassTarget(hash: "#report/r", url: hosted), local: local))
  }

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

  func testReviewDestinationIsSeparateFromCanonicalPRIdentity() throws {
    let data = Data(#"{"attention":[{"id":"a","verb":"pr:ready","kind":"pr:ready","prUrl":"https://github.com/acme/web/pull/42","reviewUrl":"https://linear.review/acme/web/pull/42","petOpen":"helm"}]}"#.utf8)
    let item = try XCTUnwrap(JSONDecoder().decode(AttentionReport.self, from: data).attention.first)
    XCTAssertEqual(item.prLink?.absoluteString, "https://linear.review/acme/web/pull/42")
    XCTAssertEqual(item.prUrl, "https://github.com/acme/web/pull/42")
  }
  func testLinearDesktopReviewOpensDirectlyForEveryReportDecisionRoute() throws {
    for route in ["tab", "app", "helm"] {
      let data = Data("{\"attention\":[{\"id\":\"a\",\"verb\":\"pr:ready\",\"kind\":\"pr:ready\",\"prUrl\":\"https://github.com/acme/web/pull/42\",\"reviewUrl\":\"linear://review/acme/web/pull/42\",\"petOpen\":\"\(route)\"}]}".utf8)
      let item = try XCTUnwrap(JSONDecoder().decode(AttentionReport.self, from: data).attention.first)
      var hostedItem = item
      hostedItem.grounds = "away"
      hostedItem.glass = "https://glass.example/#job/remote"
      var opened: URL?
      clickAttentionItem(hostedItem, glass: URL(string: "http://127.0.0.1:63169")!,
        open: { opened = $0 }, focusHelm: { _ in XCTFail("PRs never focus helm") },
        showApp: { _, _ in XCTFail("PRs never open the glass app") }, acknowledge: { _ in })
      XCTAssertEqual(opened?.absoluteString, "linear://review/acme/web/pull/42")
      XCTAssertEqual(item.prUrl, "https://github.com/acme/web/pull/42")
    }
  }
  func testStackPetShowsItsHeadlineAndOpensTheLinearApp() throws {
    let data = Data(#"{"attention":[{"id":"a","verb":"stack-ready","kind":"stack-ready","note":"stack ready to merge: Heavy-check queue (#326 → #329, 4 PRs, all green)","headline":"Heavy-check queue (4 PRs, all green)","prUrl":"https://github.com/base-research-ai/homebase/pull/329","reviewUrl":"linear://review/base-research-ai/homebase/pull/329"}]}"#.utf8)
    let item = try XCTUnwrap(JSONDecoder().decode(AttentionReport.self, from: data).attention.first)
    XCTAssertEqual(item.bubbleText, "stack ready · Heavy-check queue (4 PRs, all green)")
    XCTAssertEqual(item.prLink?.absoluteString, "linear://review/base-research-ai/homebase/pull/329")
    var opened: URL?
    clickAttentionItem(item, glass: URL(string: "http://127.0.0.1:63169")!,
      open: { opened = $0 }, focusHelm: { _ in XCTFail("PRs never focus helm") },
      showApp: { _, _ in XCTFail("PRs never open the glass app") }, acknowledge: { _ in })
    XCTAssertEqual(opened?.absoluteString, "linear://review/base-research-ai/homebase/pull/329")
  }
  func testPrPetWithNoReviewToolOpensGitHub() throws {
    let data = Data(##"{"attention":[{"id":"a","verb":"pr:ready","kind":"pr:ready","note":"#7 Put job photos first · ready to merge","prUrl":"https://github.com/acme/web/pull/7","reviewUrl":"https://github.com/acme/web/pull/7"}]}"##.utf8)
    let item = try XCTUnwrap(JSONDecoder().decode(AttentionReport.self, from: data).attention.first)
    XCTAssertEqual(item.bubbleText, "ready · #7 Put job photos first · ready to merge")
    XCTAssertEqual(item.prLink?.absoluteString, "https://github.com/acme/web/pull/7")
  }
  func testAPetStandingForMoreKeepsItsTargetAndHeadline() throws {
    let data = Data(#"{"attention":[{"id":"a","verb":"stack-ready","kind":"stack-ready","note":"the long line","headline":"Heavy-check queue (4 PRs, all green)","prUrl":"https://github.com/acme/web/pull/9","reviewUrl":"linear://review/acme/web/pull/9"}]}"#.utf8)
    let item = try XCTUnwrap(JSONDecoder().decode(AttentionReport.self, from: data).attention.first)
    let standing = item.standingFor(extra: 2)
    XCTAssertEqual(standing.bubbleText, "stack ready · Heavy-check queue (4 PRs, all green) (+2 more)")
    XCTAssertEqual(standing.prLink?.absoluteString, "linear://review/acme/web/pull/9")
  }
  func testALongBubbleIsCutToFit() {
    var item = AttentionItem(id: "a", verb: "pr:ready", note: String(repeating: "x", count: 200), kind: "pr:ready")
    XCTAssertEqual(item.bubbleLine.count, 80)
    XCTAssertTrue(item.bubbleLine.hasSuffix("…"))
    item.headline = "short"
    XCTAssertEqual(item.bubbleLine, "ready · short")
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
