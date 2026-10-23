import SwiftUI
import DSHBotsCore

/// Semantic values from DSH ui-theme/design-platform.css (0.2.0-rc.2).
enum DSHTheme {
    static func adaptive(_ light: UInt32, _ dark: UInt32) -> Color {
        Color(uiColor: UIColor { traits in let n = traits.userInterfaceStyle == .dark ? dark : light; return UIColor(red: CGFloat((n >> 16) & 255) / 255, green: CGFloat((n >> 8) & 255) / 255, blue: CGFloat(n & 255) / 255, alpha: 1) })
    }
    static let background = adaptive(0xFFFFFF, 0x151517)
    static let text = adaptive(0x0F1115, 0xF9FAFB)
    static let secondary = adaptive(0x81858C, 0xADB2B8)
    static let surface = adaptive(0xF1F3F5, 0x353638)
    static let bubble = adaptive(0xEDF3FE, 0x2C2C2E)
    static let accent = Color(red: 65/255, green: 118/255, blue: 230/255)
    static let border = Color.primary.opacity(0.10)
    static let colors = ["charcoal", "blue", "teal", "violet", "amber", "coral"]
}
struct WhaleAvatar: View {
    var color = "charcoal"
    var size: CGFloat = 40
    // The same artwork and source bounds as desktop Avatar.tsx; no substitute icon.
    private static let crops: [CGRect] = [CGRect(x: 38,y: 120,width: 490,height: 351), CGRect(x: 541,y: 126,width: 471,height: 344), CGRect(x: 1026,y: 120,width: 479,height: 351), CGRect(x: 42,y: 556,width: 479,height: 341), CGRect(x: 541,y: 557,width: 473,height: 338), CGRect(x: 1028,y: 550,width: 478,height: 346)]
    private static let images: [UIImage] = crops.compactMap { rect in UIImage(named: "whale-avatars.png")?.cgImage?.cropping(to: rect).map { UIImage(cgImage: $0) } }
    var body: some View {
        Group { if let img = Self.images.indices.contains(DSHTheme.colors.firstIndex(of: color) ?? 0) ? Self.images[DSHTheme.colors.firstIndex(of: color) ?? 0] : nil { Image(uiImage: img).resizable().scaledToFit().padding(size * 0.094) } }
            .frame(width: size, height: size).accessibilityHidden(true)
    }
}
func statusLabel(_ value: String) -> String {
    ["queued":"排队中", "dispatching":"正在派发", "accepted":"已接收", "running":"运行中", "waiting_user":"等待回复", "completed":"已完成", "failed":"执行失败", "cancelled":"已停止", "interrupted":"已停止", "recovery_required":"需要恢复", "unpaired":"未连接电脑", "connecting":"正在连接", "authenticating":"正在认证", "syncing":"正在同步", "online":"已连接", "offline":"电脑离线", "revoked":"设备凭据已失效，请重新扫码", "incompatible":"协议版本不兼容", "untrusted":"电脑证书无法验证"][value] ?? value
}
extension View {
    func dshCard() -> some View { padding(14).background(DSHTheme.background, in: RoundedRectangle(cornerRadius: 12)).overlay(RoundedRectangle(cornerRadius: 12).stroke(DSHTheme.border)) }
}
