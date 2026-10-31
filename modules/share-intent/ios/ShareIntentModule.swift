import ExpoModulesCore
import Foundation

// iOS side of share-intent. The Share Extension (plugins/ios-share-extension) cannot
// reach the running app, so it leaves the share in the App Group folder:
//   <group>/share/payload.json + 0.jpg ...
// take() reads it once and deletes it, returning the same shape Android does:
// { text, subject, images: [JPEG data URLs] }.
public class ShareIntentModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ShareIntent")

    Function("take") { () -> [String: Any]? in
      let groupId = "group." + (Bundle.main.bundleIdentifier ?? "com.pearlist")
      guard let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: groupId) else { return nil }
      let dir = root.appendingPathComponent("share", isDirectory: true)
      defer { try? FileManager.default.removeItem(at: dir) }
      guard let data = try? Data(contentsOf: dir.appendingPathComponent("payload.json")),
            let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
      let names = (obj["images"] as? [String]) ?? []
      let images = names.compactMap { name -> String? in
        guard let bytes = try? Data(contentsOf: dir.appendingPathComponent(name)) else { return nil }
        return "data:image/jpeg;base64," + bytes.base64EncodedString()
      }
      let text = obj["text"] as? String
      if (text ?? "").isEmpty && images.isEmpty { return nil }
      var out: [String: Any] = ["images": images]
      if let t = text { out["text"] = t }
      if let s = obj["subject"] as? String { out["subject"] = s }
      return out
    }
  }
}
