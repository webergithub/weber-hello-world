package com.trailmate.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 注册自定义蓝牙自组网插件
        registerPlugin(BleMeshPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
