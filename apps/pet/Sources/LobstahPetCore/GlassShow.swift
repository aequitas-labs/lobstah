import Foundation

// MARK: - showing an item in a glass that is already open

/// What `lobstah glass show <hash> --json` prints: whether a glass page was
/// seen recently, and the app it runs in (apps/cli/src/glass-presence.ts).
public struct GlassShowResult: Decodable, Equatable {
  public var delivered: Bool
  /// claude | chrome | edge | firefox | safari | electron | other
  public var host: String?
  public var visible: Bool?
  public var seenAgoMs: Double?

  public init(delivered: Bool, host: String? = nil, visible: Bool? = nil, seenAgoMs: Double? = nil) {
    self.delivered = delivered
    self.host = host
    self.visible = visible
    self.seenAgoMs = seenAgoMs
  }
}

/// A pet click's glass target: the hash an open glass page moves to, and the
/// URL a new tab opens when no page is open.
public struct GlassTarget: Equatable {
  public let hash: String
  public let url: URL

  public init(hash: String, url: URL) {
    self.hash = hash
    self.url = url
  }
}

public let claudeDesktopBundle = "com.anthropic.claudefordesktop"

/// The apps a page's host can be, most likely first. Arc and Brave send
/// Chrome's user agent, so `chrome` lists them too; the first one running wins.
public func glassHostBundles(_ host: String?) -> [String] {
  switch host {
  case "claude": return [claudeDesktopBundle]
  case "chrome":
    return ["com.google.Chrome", "company.thebrowser.Browser", "com.brave.Browser", "com.vivaldi.Vivaldi",
            "com.operasoftware.Opera", "org.chromium.Chromium", "com.google.Chrome.canary"]
  case "edge": return ["com.microsoft.edgemac"]
  case "firefox": return ["org.mozilla.firefox", "org.mozilla.firefoxdeveloperedition", "org.mozilla.nightly"]
  case "safari": return ["com.apple.Safari", "com.apple.SafariTechnologyPreview"]
  default: return []
  }
}

/// How a click reaches the glass.
public enum GlassRoute: Equatable {
  /// A page was seen recently and will show the item: bring the first running
  /// app of these to the front, then open the helm's session link if there is one.
  case raise(bundleIds: [String], sessionLink: URL?)
  /// No page was seen recently, or the glass did not answer: today's path.
  case fallback
}

/// The route for a show's answer. A Claude desktop page raises the Claude app
/// and, when the helm recorded a `claude://` session link, opens it so the
/// helm's session (with its Browser pane) comes forward. A browser page raises
/// that browser only: the default browser first when it fits the user agent,
/// and the default browser alone when the user agent names none.
public func glassRoute(_ result: GlassShowResult?, helm: HelmRegistration?, defaultBrowser: String? = nil) -> GlassRoute {
  guard let result, result.delivered else { return .fallback }
  if result.host == "claude" {
    let link = helm?.link.flatMap { $0.hasPrefix("claude://claude.ai/") ? URL(string: $0) : nil }
    return .raise(bundleIds: [claudeDesktopBundle], sessionLink: link)
  }
  var bundles = glassHostBundles(result.host)
  if let defaultBrowser {
    if bundles.isEmpty { bundles = [defaultBrowser] }
    else if let at = bundles.firstIndex(of: defaultBrowser) { bundles.insert(bundles.remove(at: at), at: 0) }
  }
  return .raise(bundleIds: bundles, sessionLink: nil)
}

/// The CLI call behind a click: ask the glass on `port` to show `hash`.
public func glassShowArguments(_ hash: String, port: Int) -> [String] {
  ["glass", "show", hash, "--port", String(port), "--json"]
}

/// A show's answer, or nil when the CLI failed (no glass, an older lobstah).
public func decodeGlassShow(_ outcome: CommandOutcome) -> GlassShowResult? {
  guard case let .exited(status, data) = outcome, status == 0 else { return nil }
  return try? JSONDecoder().decode(GlassShowResult.self, from: data)
}

/// What a glass click did, for the log and the tests.
public enum GlassClickOutcome: Equatable {
  /// An open page shows the item; this app came forward.
  case raised(String)
  /// No open page (or its app would not come forward): the fallback ran.
  case fellBack
}

/// Show `target` in a glass page that is already open, and bring that page's
/// app forward; open nothing new. With no page seen recently, or when no app
/// of the route comes forward, run `otherwise` (a new tab, as before).
///
/// - `show` runs `lobstah glass show` (blocking: call off the main thread).
/// - `activate` brings the first running app of the list forward, returning its bundle id.
/// - `open` opens a URL (the helm's session link).
@discardableResult
public func showInGlass(
  _ target: GlassTarget,
  helm: HelmRegistration?,
  defaultBrowser: String?,
  show: (String) -> GlassShowResult?,
  activate: ([String]) -> String?,
  open: (URL) -> Void,
  otherwise: () -> Void
) -> GlassClickOutcome {
  switch glassRoute(show(target.hash), helm: helm, defaultBrowser: defaultBrowser) {
  case .fallback:
    otherwise()
    return .fellBack
  case let .raise(bundles, link):
    guard let raised = activate(bundles) else {
      otherwise()
      return .fellBack
    }
    if let link { open(link) }
    return .raised(raised)
  }
}
