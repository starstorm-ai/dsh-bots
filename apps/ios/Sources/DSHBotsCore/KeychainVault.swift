import Foundation
import Security

public enum KeychainVault {
    private static let service = "com.dsh.bots.hosts.v1"
    public static func load() throws -> [TrustedHost] {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: "hosts", kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var result: CFTypeRef?; let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return [] }
        guard status == errSecSuccess, let data = result as? Data else { throw HostError("KEYCHAIN", "无法读取已信任电脑") }
        return try JSONDecoder().decode([TrustedHost].self, from: data)
    }
    public static func save(_ hosts: [TrustedHost]) throws {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: "hosts"]
        let attributes: [String: Any] = [kSecValueData as String: try JSONEncoder().encode(hosts), kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            guard SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil) == errSecSuccess else { throw HostError("KEYCHAIN", "无法保存设备凭据") }
        } else if status != errSecSuccess { throw HostError("KEYCHAIN", "无法更新设备凭据") }
    }
}

public struct InviteAttempt: Codable, Sendable {
    public let input: String
    public let id: String
    public let challenge: String
    public init(input: String) { self.input = input; id = UUID().uuidString; challenge = UUID().uuidString + UUID().uuidString }
}
extension KeychainVault {
    public static func attempt(for input: String) throws -> InviteAttempt {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: "invite-attempt"]
        var result: CFTypeRef?
        var read = query; read[kSecReturnData as String] = true
        let status = SecItemCopyMatching(read as CFDictionary, &result)
        if status == errSecSuccess, let data = result as? Data, let value = try? JSONDecoder().decode(InviteAttempt.self, from: data), value.input == input { return value }
        guard status == errSecSuccess || status == errSecItemNotFound else { throw HostError("KEYCHAIN", "无法恢复邀请请求") }
        let value = InviteAttempt(input: input)
        let attributes: [String: Any] = [kSecValueData as String: try JSONEncoder().encode(value), kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        if status == errSecItemNotFound {
            guard SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil) == errSecSuccess else { throw HostError("KEYCHAIN", "无法保存邀请请求") }
        } else if SecItemUpdate(query as CFDictionary, attributes as CFDictionary) != errSecSuccess { throw HostError("KEYCHAIN", "无法保存邀请请求") }
        return value
    }
    public static func clearAttempt() throws {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: "invite-attempt"]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw HostError("KEYCHAIN", "无法清理邀请请求") }
    }
}
