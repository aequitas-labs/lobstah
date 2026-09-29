import Foundation

/// One line to the pet's standard output, which the LaunchAgent sends to
/// `~/.lobstah/logs/pet.log`. Unbuffered: a log file is not a terminal, and
/// a buffered line may never reach the disk.
public func petLog(_ message: String) {
  let stamp = ISO8601DateFormatter().string(from: Date())
  FileHandle.standardOutput.write(Data("\(stamp) lobstah pet: \(message)\n".utf8))
}

/// What `lobstah doctor` reads: `~/.lobstah/pet/state.json`.
public struct PetState: Codable, Equatable {
  public let pid: Int32
  /// When the last read finished (ISO 8601).
  public let at: String
  /// Whether the last read produced an attention list.
  public let ok: Bool
  /// The command that worked, as typed after `lobstah`.
  public let command: String?
  /// Why the last read failed.
  public let reason: String?
  public let consecutiveFailures: Int
  /// Items walking after the last good read.
  public let items: Int?
  /// When a read last worked (ISO 8601).
  public let lastOkAt: String?
}

public func petStateFile(home: URL = lobstahHome()) -> URL {
  home.appendingPathComponent("pet").appendingPathComponent("state.json")
}

/// Tracks reads in a row. It logs one line when failures reach the
/// threshold, one line when reads work again, and one line when the
/// working command changes. It writes the state file after every read.
public final class ReadMonitor {
  public let threshold: Int
  public private(set) var consecutiveFailures = 0
  private var lastOkAt: Date?
  private var lastCommand: String?
  private let log: (String) -> Void
  private let stateFile: URL?
  private var writeFailed = false

  public init(threshold: Int = 3, stateFile: URL? = petStateFile(), log: @escaping (String) -> Void = petLog) {
    self.threshold = threshold
    self.stateFile = stateFile
    self.log = log
  }

  public func record(_ read: AttentionRead, now: Date = Date()) {
    if let items = read.items {
      if consecutiveFailures >= threshold {
        log("attention read works again after \(consecutiveFailures) failures")
      }
      if read.command != lastCommand, let command = read.command {
        log("reading attention with `lobstah \(command)`")
        lastCommand = command
      }
      consecutiveFailures = 0
      lastOkAt = now
      write(PetState(pid: getpid(), at: iso(now), ok: true, command: read.command, reason: nil,
                     consecutiveFailures: 0, items: items.count, lastOkAt: iso(now)))
    } else {
      consecutiveFailures += 1
      let reason = read.failure ?? "unknown"
      if consecutiveFailures == threshold {
        log("attention read failed \(consecutiveFailures) times in a row: \(reason)")
      }
      write(PetState(pid: getpid(), at: iso(now), ok: false, command: nil, reason: reason,
                     consecutiveFailures: consecutiveFailures, items: nil, lastOkAt: lastOkAt.map(iso)))
    }
  }

  private func iso(_ date: Date) -> String {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f.string(from: date)
  }

  private func write(_ state: PetState) {
    guard let stateFile else { return }
    do {
      try FileManager.default.createDirectory(at: stateFile.deletingLastPathComponent(), withIntermediateDirectories: true)
      let encoder = JSONEncoder()
      encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
      try encoder.encode(state).write(to: stateFile, options: .atomic)
      writeFailed = false
    } catch {
      if !writeFailed { log("cannot write \(stateFile.path): \(error.localizedDescription)") }
      writeFailed = true
    }
  }
}
