import Foundation

// MARK: - lobstah state

public struct AckInfo: Decodable, Equatable {
  public let at: String
  public let by: String
}

public struct AttentionItem: Decodable, Equatable {
  public let id: String
  public let verb: String
  public let note: String?
  /** The stable item key `lobstah attention ack` takes — absent from an older lobstah. */
  public var key: String? = nil
  /** Acknowledged for display: the pet skips it (the helm's wakes never do). */
  public var acked: AckInfo? = nil
  /** question | landed | watch | pr:draft | pr:review | pr:checks | pr:conflict | pr:ready | report — absent from an older lobstah. */
  public var kind: String? = nil
  /** pr:* kinds: the PR this pet walks for. */
  public var prUrl: String? = nil

  public init(id: String, verb: String, note: String?, key: String? = nil, acked: AckInfo? = nil, kind: String? = nil, prUrl: String? = nil) {
    self.id = id
    self.verb = verb
    self.note = note
    self.key = key
    self.acked = acked
    self.kind = kind
    self.prUrl = prUrl
  }

  /** The identity stays fixed when labels, order, or acknowledgements change. */
  public var identity: String { "\(kind ?? "question"):\(key ?? id)" }

  /** pr:* pets click through to the PR; question, landed, and watch go to the helm. */
  public var prLink: URL? { (kind?.hasPrefix("pr:") ?? false) ? prUrl.flatMap(URL.init(string:)) : nil }

  /** A report pet clicks through to the spyglass at the report's modal (#report/<key>). */
  public func reportLink(glass: URL) -> URL? {
    guard kind == "report", let key, let encoded = key.addingPercentEncoding(withAllowedCharacters: .alphanumerics) else { return nil }
    return URL(string: "\(glass.absoluteString)/#report/\(encoded)")
  }

  /** The CLI acknowledgement for a pet click or its Acknowledge menu entry. */
  public var ackArguments: [String]? {
    key.map { ["attention", "ack", $0, "--by", "pet"] }
  }

  /** The short kind label shown before the note; nothing for a question. */
  public var kindLabel: String? {
    switch kind {
    case "pr:draft": return "draft"
    case "pr:review": return "review"
    case "pr:checks": return "checks"
    case "pr:conflict": return "conflicts"
    case "pr:ready": return "ready"
    case "landed": return "landed"
    case "watch": return "watch"
    case "report": return "report"
    default: return nil
    }
  }

  /** Bubble text: the label, then the note. */
  public var bubbleText: String {
    let body = note ?? verb
    return kindLabel.map { "\($0) · \(body)" } ?? body
  }
}

/// Opens a pet's target before acknowledging it. Items without a URL focus the helm.
public func clickAttentionItem(
  _ item: AttentionItem,
  glass: URL,
  open: (URL) -> Void,
  focusHelm: () -> Void,
  acknowledge: ([String]) -> Void
) {
  if let url = item.reportLink(glass: glass) ?? item.prLink {
    open(url)
  } else {
    focusHelm()
  }
  if let args = item.ackArguments { acknowledge(args) }
}

/// The shape both reads share: `lobstah attention --json` prints
/// `{ "attention": [...] }`, and `lobstah man tend --json` prints the whole
/// report with the same list under `attention`.
public struct AttentionReport: Decodable {
  public let attention: [AttentionItem]
}

public func lobstahHome() -> URL {
  if let home = ProcessInfo.processInfo.environment["LOBSTAH_HOME"] {
    return URL(fileURLWithPath: home)
  }
  return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".lobstah")
}

// MARK: - the attention read

/// Runs `lobstah <args>` and returns how it ended.
public typealias LobstahRunner = ([String]) -> CommandOutcome

/// Seconds each lobstah read may take.
public let readTimeout: TimeInterval = 10

public let defaultRunner: LobstahRunner = { args in
  execute("/usr/bin/env", ["lobstah"] + args, timeout: readTimeout).outcome
}

/// The narrow command first. An older lobstah has no `attention --json`
/// (it exits 2 on the unknown flag), so the whole report is the fallback.
public let attentionCommands: [[String]] = [
  ["attention", "--json"],
  ["man", "tend", "--json"],
]

public struct AttentionRead: Equatable {
  /// Items to walk (acknowledged items removed); nil when every command failed.
  public let items: [AttentionItem]?
  /// The command that worked, as typed after `lobstah`.
  public let command: String?
  /// Why each command failed, when all failed.
  public let failure: String?
}

/// Why one outcome is not an attention list, or the list.
public func decodeAttention(_ outcome: CommandOutcome) -> Result<[AttentionItem], ReadFailure> {
  switch outcome {
  case .timedOut:
    return .failure(.timeout)
  case .launchFailed(let why):
    return .failure(.launch(why))
  case let .exited(status, data):
    if status != 0 { return .failure(.exit(status)) }
    guard let report = try? JSONDecoder().decode(AttentionReport.self, from: data) else {
      return .failure(.undecodable(data.count))
    }
    return .success(report.attention)
  }
}

public enum ReadFailure: Error, Equatable, CustomStringConvertible {
  case timeout
  case exit(Int32)
  case undecodable(Int)
  case launch(String)

  public var description: String {
    switch self {
    case .timeout: return "timed out"
    case .exit(let status): return "exited with status \(status)"
    case .undecodable(let bytes): return "output does not decode (\(bytes) bytes)"
    case .launch(let why): return "did not start (\(why))"
    }
  }
}

/// Reads the attention list: the narrow command, then the fallback.
/// Acknowledgements are display-only: an acked item stays in lobstah's
/// attention (the helm still needs it) but no longer walks.
public func readAttention(run: LobstahRunner = defaultRunner) -> AttentionRead {
  var reasons: [String] = []
  for args in attentionCommands {
    let label = args.joined(separator: " ")
    switch decodeAttention(run(args)) {
    case .success(let items):
      return AttentionRead(items: items.filter { $0.acked == nil }, command: label, failure: nil)
    case .failure(let why):
      reasons.append("`lobstah \(label)` \(why)")
    }
  }
  return AttentionRead(items: nil, command: nil, failure: reasons.joined(separator: "; "))
}

/// A write command (`attention ack`) works when it exits 0; its output is not read.
public func ackOutcome(_ outcome: CommandOutcome) -> Result<Void, ReadFailure> {
  switch outcome {
  case .timedOut: return .failure(.timeout)
  case .launchFailed(let why): return .failure(.launch(why))
  case let .exited(status, _): return status == 0 ? .success(()) : .failure(.exit(status))
  }
}
