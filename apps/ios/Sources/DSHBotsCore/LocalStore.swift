import Foundation
import CSQLite

/// One connection, confined to the UI/repository actor. Transactions own cache + cursor + outbox acknowledgement.
@MainActor public final class LocalStore {
    private var db: OpaquePointer?
    public init(path: String) throws {
        guard sqlite3_open(path, &db) == SQLITE_OK else { throw HostError("STORAGE", "无法打开本地数据库") }
        do {
            try execute("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;")
            var versionStatement: OpaquePointer?
            guard sqlite3_prepare_v2(db, "PRAGMA user_version", -1, &versionStatement, nil) == SQLITE_OK else { throw HostError("STORAGE", "无法读取数据库版本") }
            let version = sqlite3_step(versionStatement) == SQLITE_ROW ? sqlite3_column_int(versionStatement, 0) : -1
            sqlite3_finalize(versionStatement)
            guard version >= 0 && version <= 1 else { throw HostError("STORAGE_VERSION", "本地数据库版本较新，请升级 App") }
            try execute("CREATE TABLE IF NOT EXISTS records(scope TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, value BLOB NOT NULL, PRIMARY KEY(scope,kind,key)); PRAGMA user_version=1;")
        } catch { sqlite3_close(db); db = nil; throw error }
    }
    isolated deinit { sqlite3_close(db) }
    private func execute(_ sql: String) throws { guard sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK else { throw HostError("STORAGE", "本地数据库操作失败") } }
    private func statement(_ sql: String, _ values: [String]) throws -> OpaquePointer {
        var s: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &s, nil) == SQLITE_OK, let s else { throw HostError("STORAGE", "本地数据库读取失败") }
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        for (i, value) in values.enumerated() { _ = value.withCString { sqlite3_bind_text(s, Int32(i + 1), $0, -1, transient) } }
        return s
    }
    public func get(_ scope: String, _ kind: String, _ key: String) throws -> JSON? {
        let s = try statement("SELECT value FROM records WHERE scope=? AND kind=? AND key=?", [scope, kind, key]); defer { sqlite3_finalize(s) }
        let result = sqlite3_step(s)
        if result == SQLITE_DONE { return nil }
        guard result == SQLITE_ROW, let ptr = sqlite3_column_blob(s, 0) else { throw HostError("STORAGE", "缓存读取失败") }
        return try JSON.decode(Data(bytes: ptr, count: Int(sqlite3_column_bytes(s, 0))))
    }
    public func list(_ scope: String, _ kind: String) throws -> [JSON] {
        let s = try statement("SELECT value FROM records WHERE scope=? AND kind=? ORDER BY rowid", [scope, kind]); defer { sqlite3_finalize(s) }
        var result: [JSON] = []
        while true {
            let status = sqlite3_step(s); if status == SQLITE_DONE { return result }
            guard status == SQLITE_ROW, let ptr = sqlite3_column_blob(s, 0) else { throw HostError("STORAGE", "缓存读取失败") }
            result.append(try JSON.decode(Data(bytes: ptr, count: Int(sqlite3_column_bytes(s, 0)))))
        }
    }
    public func put(_ scope: String, _ kind: String, _ key: String, _ value: JSON) throws {
        let s = try statement("INSERT INTO records(scope,kind,key,value) VALUES(?,?,?,?) ON CONFLICT(scope,kind,key) DO UPDATE SET value=excluded.value", [scope, kind, key]); defer { sqlite3_finalize(s) }
        let data = try value.data(), transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        _ = data.withUnsafeBytes { sqlite3_bind_blob(s, 4, $0.baseAddress, Int32(data.count), transient) }
        guard sqlite3_step(s) == SQLITE_DONE else { throw HostError("STORAGE", "无法保存消息，请检查剩余空间") }
    }
    public func remove(_ scope: String, _ kind: String, _ key: String) throws {
        let s = try statement("DELETE FROM records WHERE scope=? AND kind=? AND key=?", [scope, kind, key]); defer { sqlite3_finalize(s) }
        guard sqlite3_step(s) == SQLITE_DONE else { throw HostError("STORAGE", "无法更新缓存") }
    }
    public func purgeScope(_ scope: String) throws {
        let s = try statement("DELETE FROM records WHERE scope=?", [scope]); defer { sqlite3_finalize(s) }
        guard sqlite3_step(s) == SQLITE_DONE else { throw HostError("STORAGE", "无法清除缓存") }
    }
    public func transaction(_ operation: () throws -> Void) throws {
        try execute("BEGIN IMMEDIATE")
        do { try operation(); try execute("COMMIT") } catch { try? execute("ROLLBACK"); throw error }
    }
    public func commitSnapshot(_ scope: String, _ snapshot: JSON) throws {
        try transaction {
            try put(scope, "room", snapshot["room"].id, snapshot)
            for m in snapshot["messages"].array where !m["clientMessageId"].string.isEmpty { try remove(scope, "outbox", m["clientMessageId"].string) }
        }
    }
    public func purgeRoom(_ scope: String, _ roomId: String) throws {
        try transaction {
            try remove(scope, "room", roomId); try remove(scope, "draft", roomId)
            for m in try list(scope, "outbox") where m["roomId"].string == roomId { try remove(scope, "outbox", m.id) }
        }
    }
    public func enqueue(_ scope: String, roomId: String, draft: JSON) throws -> JSON {
        let text = draft["text"].string
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw HostError("EMPTY_MESSAGE", "请输入消息") }
        let parts = draft["parts"]
        guard try parts.data().count <= 32768, parts.array.count <= 64 else { throw HostError("PAYLOAD_TOO_LARGE", "消息超过 32 KiB") }
        var item = draft; item["id"] = .string(UUID().uuidString); item["roomId"] = .string(roomId); item["createdAt"] = .string(ISO8601DateFormatter().string(from: Date()))
        try transaction { try put(scope, "outbox", item.id, item); try remove(scope, "draft", roomId) }; return item
    }
}
