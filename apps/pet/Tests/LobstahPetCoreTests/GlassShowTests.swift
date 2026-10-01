import Foundation
import XCTest
@testable import LobstahPetCore

/// A report or decision click shows the item in a glass that is already open
/// and brings that page's app forward; only with no open page does it open a
/// new tab (the old click).
final class GlassShowTests: XCTestCase {
  private let glass = URL(string: "http://127.0.0.1:4949")!
  private let decision = AttentionItem(id: "abc", verb: "decision", note: "Cut 0.6.0?", key: "decision:0a1b2c3d", kind: "decision")
  private let report = AttentionItem(id: "r", verb: "report", note: "Tray findings", key: "fleet/r1", kind: "report")
  private let desktopHelm = HelmRegistration(sessionId: "s", harness: "claude", heartbeatAt: "2026-10-01T16:00:00.000Z",
                                             window: HelmWindow(bundleId: "com.anthropic.claudefordesktop"),
                                             link: "claude://claude.ai/code/session_01abc")

  /// Everything a click did, in order.
  private final class Recorder {
    var shown: [String] = []
    var activated: [[String]] = []
    var opened: [String] = []
    var fellBack = 0
    /// The apps that are running, for `activate`.
    var running: Set<String> = []
  }

  private func click(_ item: AttentionItem, answer: GlassShowResult?, helm: HelmRegistration? = nil,
                     defaultBrowser: String? = "com.google.Chrome", running: Set<String>) -> (Recorder, GlassClickOutcome?, [String]) {
    let r = Recorder()
    r.running = running
    var outcome: GlassClickOutcome?
    var newTabs: [String] = []
    clickAttentionItem(item, glass: glass,
      open: { newTabs.append($0.absoluteString) },
      focusHelm: { _ in XCTFail("no live helm in these clicks") },
      showGlass: { target, otherwise in
        outcome = showInGlass(target, helm: helm, defaultBrowser: defaultBrowser,
          show: { r.shown.append($0); return answer },
          activate: { bundles in
            r.activated.append(bundles)
            return bundles.first { r.running.contains($0) }
          },
          open: { r.opened.append($0.absoluteString) },
          otherwise: { r.fellBack += 1; otherwise() })
      },
      acknowledge: { _ in })
    return (r, outcome, newTabs)
  }

  func testTargetsCarryTheHashAnOpenPageReadsAndTheURLANewTabOpens() {
    XCTAssertEqual(decision.glassTarget(glass: glass),
                   GlassTarget(hash: "#decision/decision%3A0a1b2c3d", url: URL(string: "http://127.0.0.1:4949/#decision/decision%3A0a1b2c3d")!))
    XCTAssertEqual(report.glassTarget(glass: glass),
                   GlassTarget(hash: "#report/fleet%2Fr1", url: URL(string: "http://127.0.0.1:4949/report/fleet%2Fr1")!))
    let pr = AttentionItem(id: "p", verb: "pr", note: nil, key: "pr:o/r#1", kind: "pr:draft", prUrl: "https://github.com/o/r/pull/1")
    XCTAssertNil(pr.glassTarget(glass: glass))
  }

  func testARecentDesktopPageRaisesClaudeAndOpensTheHelmSessionWithNoNewTab() {
    let (r, outcome, newTabs) = click(decision, answer: GlassShowResult(delivered: true, host: "claude", visible: false, seenAgoMs: 20_000),
                                      helm: desktopHelm, running: ["com.anthropic.claudefordesktop", "com.google.Chrome"])
    XCTAssertEqual(r.shown, ["#decision/decision%3A0a1b2c3d"])
    XCTAssertEqual(r.activated, [["com.anthropic.claudefordesktop"]])
    XCTAssertEqual(r.opened, ["claude://claude.ai/code/session_01abc"])
    XCTAssertEqual(outcome, .raised("com.anthropic.claudefordesktop"))
    XCTAssertEqual(newTabs, [])
    XCTAssertEqual(r.fellBack, 0)
  }

  func testADesktopPageWithNoHelmLinkOnlyRaisesClaude() {
    let (r, outcome, newTabs) = click(report, answer: GlassShowResult(delivered: true, host: "claude", visible: true, seenAgoMs: 1_000),
                                      running: ["com.anthropic.claudefordesktop"])
    XCTAssertEqual(r.shown, ["#report/fleet%2Fr1"])
    XCTAssertEqual(r.activated, [["com.anthropic.claudefordesktop"]])
    XCTAssertEqual(r.opened, [])
    XCTAssertEqual(outcome, .raised("com.anthropic.claudefordesktop"))
    XCTAssertEqual(newTabs, [])
  }

  func testARecentChromePageRaisesChromeOnlyAndNeverTheHelmLink() {
    let (r, outcome, newTabs) = click(report, answer: GlassShowResult(delivered: true, host: "chrome", visible: true, seenAgoMs: 1_500),
                                      helm: desktopHelm, defaultBrowser: "com.google.Chrome",
                                      running: ["com.anthropic.claudefordesktop", "com.google.Chrome"])
    XCTAssertEqual(r.activated.first?.first, "com.google.Chrome")
    XCTAssertEqual(r.opened, [])
    XCTAssertEqual(outcome, .raised("com.google.Chrome"))
    XCTAssertEqual(newTabs, [])
  }

  func testNoRecentPageOpensANewTabAsBefore() {
    let (r, outcome, newTabs) = click(report, answer: GlassShowResult(delivered: false),
                                      helm: desktopHelm, running: ["com.anthropic.claudefordesktop", "com.google.Chrome"])
    XCTAssertEqual(r.activated, [])
    XCTAssertEqual(r.opened, [])
    XCTAssertEqual(outcome, .fellBack)
    XCTAssertEqual(newTabs, ["http://127.0.0.1:4949/report/fleet%2Fr1"])
  }

  func testNoGlassAnsweringOpensANewTabAsBefore() {
    let (_, outcome, newTabs) = click(decision, answer: nil, running: [])
    XCTAssertEqual(outcome, .fellBack)
    XCTAssertEqual(newTabs, ["http://127.0.0.1:4949/#decision/decision%3A0a1b2c3d"])
  }

  func testAPageWhoseAppIsNotRunningFallsBackToANewTab() {
    let (r, outcome, newTabs) = click(report, answer: GlassShowResult(delivered: true, host: "safari"), running: ["com.google.Chrome"])
    XCTAssertEqual(r.activated, [["com.apple.Safari", "com.apple.SafariTechnologyPreview"]])
    XCTAssertEqual(outcome, .fellBack)
    XCTAssertEqual(newTabs, ["http://127.0.0.1:4949/report/fleet%2Fr1"])
  }

  func testADecisionWithNoOpenPageStillBringsUpALiveHelm() {
    var helmFocused: [String] = []
    clickAttentionItem(decision, glass: glass, helmLive: true,
      open: { _ in XCTFail("a live helm frames the decision") },
      focusHelm: { helmFocused.append($0.absoluteString) },
      showGlass: { target, otherwise in
        showInGlass(target, helm: nil, defaultBrowser: nil, show: { _ in GlassShowResult(delivered: false) },
                    activate: { _ in nil }, open: { _ in }, otherwise: otherwise)
      },
      acknowledge: { _ in })
    XCTAssertEqual(helmFocused, ["http://127.0.0.1:4949/#decision/decision%3A0a1b2c3d"])
  }

  func testPRClicksNeverAskTheGlass() {
    let pr = AttentionItem(id: "p", verb: "pr", note: nil, key: "pr:o/r#1", kind: "pr:draft", prUrl: "https://github.com/o/r/pull/1")
    var opened: [String] = []
    clickAttentionItem(pr, glass: glass,
      open: { opened.append($0.absoluteString) },
      focusHelm: { _ in XCTFail("a PR opens its URL") },
      showGlass: { _, _ in XCTFail("a PR never asks the glass") },
      acknowledge: { _ in })
    XCTAssertEqual(opened, ["https://github.com/o/r/pull/1"])
  }

  func testRouteForEachHost() {
    XCTAssertEqual(glassRoute(GlassShowResult(delivered: true, host: "chrome"), helm: nil, defaultBrowser: "company.thebrowser.Browser"),
                   .raise(bundleIds: ["company.thebrowser.Browser", "com.google.Chrome", "com.brave.Browser", "com.vivaldi.Vivaldi",
                                      "com.operasoftware.Opera", "org.chromium.Chromium", "com.google.Chrome.canary"], sessionLink: nil))
    XCTAssertEqual(glassRoute(GlassShowResult(delivered: true, host: "other"), helm: nil, defaultBrowser: "org.example.Browser"),
                   .raise(bundleIds: ["org.example.Browser"], sessionLink: nil))
    // A link that is not a Claude desktop session link is never opened.
    var helm = desktopHelm
    helm.link = "https://example.com"
    XCTAssertEqual(glassRoute(GlassShowResult(delivered: true, host: "claude"), helm: helm),
                   .raise(bundleIds: ["com.anthropic.claudefordesktop"], sessionLink: nil))
    XCTAssertEqual(glassRoute(nil, helm: helm), .fallback)
  }

  func testTheCLICallAndItsAnswer() throws {
    XCTAssertEqual(glassShowArguments("#report/x", port: 4949), ["glass", "show", "#report/x", "--port", "4949", "--json"])
    let json = #"{"delivered":true,"id":"abc","page":"p1","host":"claude","visible":false,"seenAgoMs":20000,"userAgent":"ua"}"#
    XCTAssertEqual(decodeGlassShow(.exited(status: 0, stdout: Data(json.utf8))),
                   GlassShowResult(delivered: true, host: "claude", visible: false, seenAgoMs: 20_000))
    XCTAssertNil(decodeGlassShow(.exited(status: 1, stdout: Data())))
    XCTAssertNil(decodeGlassShow(.exited(status: 0, stdout: Data("not json".utf8))))
    XCTAssertNil(decodeGlassShow(.timedOut))
  }
}
