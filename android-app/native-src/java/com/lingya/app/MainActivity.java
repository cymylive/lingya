package com.lingya.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

/**
 * LingYa 安卓入口 Activity。
 * 注册自定义文件插件 LingyaFs。
 */
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(LingyaFsPlugin.class);
        super.onCreate(savedInstanceState);
    }
}

