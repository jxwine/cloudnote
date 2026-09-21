package com.cloudnote.app;

import android.content.Intent;
import android.net.Uri;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;

/**
 * 应用内更新的最后一步：把下载好的 APK 交给系统安装页。
 *
 * 只有这一个方法，所以不值得引第三方插件。文件由 @capacitor/filesystem 下到 App 自己的缓存目录，
 * 这里经 FileProvider（Capacitor 已经在 manifest 里声明了 ${applicationId}.fileprovider，
 * file_paths.xml 覆盖 cache-path）换成 content:// 再拉起安装器。需要 REQUEST_INSTALL_PACKAGES 权限，
 * 第一次系统会引导用户去开「允许此来源安装应用」。
 */
@CapacitorPlugin(name = "Installer")
public class InstallerPlugin extends Plugin {

    @PluginMethod
    public void install(PluginCall call) {
        String path = call.getString("path");
        if (path == null || path.isEmpty()) {
            call.reject("缺少文件路径");
            return;
        }
        if (path.startsWith("file://")) path = Uri.parse(path).getPath();
        File file = new File(path);
        if (!file.exists()) {
            call.reject("安装包不存在：" + path);
            return;
        }
        try {
            String authority = getContext().getPackageName() + ".fileprovider";
            Uri uri = FileProvider.getUriForFile(getContext(), authority, file);
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve(new JSObject());
        } catch (Exception e) {
            call.reject("拉起安装页失败：" + e.getMessage());
        }
    }
}
