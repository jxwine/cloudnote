package com.cloudnote.app;

import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 自己写的插件要在 super.onCreate 之前登记，桥初始化时才能把它挂到 window.Capacitor.Plugins 上
        registerPlugin(InstallerPlugin.class);
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= 35) keyboardAwareInsets();
    }

    /**
     * Android 15 起应用强制边到边，adjustResize 不再让 WebView 给软键盘让位，
     * 编辑器贴在底部的格式工具栏就被键盘盖住了。Capacitor 自带的 inset 处理只算了系统栏，
     * 这里换成一份把 IME 也算进去的：键盘弹出多高，WebView 底边距就加多高，
     * 页面里的布局视口跟着收缩，工具栏刚好压在键盘上方。15 以下的系统走 manifest 的 adjustResize。
     */
    private void keyboardAwareInsets() {
        View web = getBridge().getWebView();
        ViewCompat.setOnApplyWindowInsetsListener(web, (v, windowInsets) -> {
            Insets bars = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            Insets ime = windowInsets.getInsets(WindowInsetsCompat.Type.ime());
            ViewGroup.MarginLayoutParams mlp = (ViewGroup.MarginLayoutParams) v.getLayoutParams();
            mlp.leftMargin = bars.left;
            mlp.rightMargin = bars.right;
            // 顶部不留边距：让页面画到状态栏底下，状态栏那条的底色就永远等于页面底色
            // （深浅色切换立刻跟上）。页面自己按 StatusBar.getInfo().height 让出高度
            mlp.topMargin = 0;
            mlp.bottomMargin = Math.max(bars.bottom, ime.bottom);
            v.setLayoutParams(mlp);
            return WindowInsetsCompat.CONSUMED;
        });
    }
}
