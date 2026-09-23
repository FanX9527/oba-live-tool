package com.obalivetool.accessibility;

import android.app.Activity;
import android.Manifest;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.os.Bundle;
import android.provider.Settings;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

public final class MainActivity extends Activity {
    private TextView statusView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setTitle(getString(R.string.app_name));

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER_HORIZONTAL);
        root.setPadding(dp(28), dp(48), dp(28), dp(32));
        root.setBackgroundColor(Color.WHITE);

        TextView title = new TextView(this);
        title.setText("OBA 真机控制");
        title.setTextSize(24);
        title.setTextColor(Color.rgb(20, 24, 32));
        title.setGravity(Gravity.CENTER);
        root.addView(title, matchWidthWrapHeight(dp(0)));

        TextView description = new TextView(this);
        description.setText("首次使用只需在无障碍设置中开启一次“OBA 真机控制”。不需要 SIM 卡，也不依赖小米 USB 调试（安全设置）。");
        description.setTextSize(16);
        description.setTextColor(Color.rgb(82, 89, 101));
        description.setGravity(Gravity.CENTER);
        description.setLineSpacing(0, 1.25f);
        LinearLayout.LayoutParams descriptionParams = matchWidthWrapHeight(dp(24));
        root.addView(description, descriptionParams);

        statusView = new TextView(this);
        statusView.setTextSize(16);
        statusView.setGravity(Gravity.CENTER);
        root.addView(statusView, matchWidthWrapHeight(dp(30)));

        Button openSettings = new Button(this);
        openSettings.setText("打开无障碍设置");
        openSettings.setAllCaps(false);
        openSettings.setOnClickListener(view -> {
            Intent intent = new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(intent);
        });
        root.addView(openSettings, matchWidthWrapHeight(dp(20)));

        setContentView(root);
    }

    @Override
    protected void onResume() {
        super.onResume();
        tryEnableServiceWithGrantedPermission();
        boolean enabled = isServiceEnabled();
        statusView.setText(enabled ? "状态：已启用，可返回电脑操作" : "状态：等待开启服务");
        statusView.setTextColor(enabled ? Color.rgb(5, 150, 105) : Color.rgb(180, 83, 9));
    }

    private boolean tryEnableServiceWithGrantedPermission() {
        if (isServiceEnabled()) return true;
        if (checkSelfPermission(Manifest.permission.WRITE_SECURE_SETTINGS)
            != PackageManager.PERMISSION_GRANTED) {
            return false;
        }

        ComponentName component = new ComponentName(this, ObaAccessibilityService.class);
        String serviceName = component.flattenToString();
        String enabledServices = Settings.Secure.getString(
            getContentResolver(),
            Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
        );
        String updatedServices = TextUtils.isEmpty(enabledServices)
            ? serviceName
            : containsService(enabledServices, component)
                ? enabledServices
                : enabledServices + ":" + serviceName;

        boolean servicesUpdated = Settings.Secure.putString(
            getContentResolver(),
            Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES,
            updatedServices
        );
        boolean accessibilityEnabled = Settings.Secure.putInt(
            getContentResolver(),
            Settings.Secure.ACCESSIBILITY_ENABLED,
            1
        );
        return servicesUpdated && accessibilityEnabled;
    }

    private boolean isServiceEnabled() {
        int accessibilityEnabled = Settings.Secure.getInt(
            getContentResolver(),
            Settings.Secure.ACCESSIBILITY_ENABLED,
            0
        );
        if (accessibilityEnabled != 1) return false;

        String enabledServices = Settings.Secure.getString(
            getContentResolver(),
            Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
        );
        if (TextUtils.isEmpty(enabledServices)) return false;

        ComponentName component = new ComponentName(this, ObaAccessibilityService.class);
        return containsService(enabledServices, component);
    }

    private boolean containsService(String enabledServices, ComponentName component) {
        TextUtils.SimpleStringSplitter splitter = new TextUtils.SimpleStringSplitter(':');
        splitter.setString(enabledServices);
        while (splitter.hasNext()) {
            ComponentName enabled = ComponentName.unflattenFromString(splitter.next());
            if (component.equals(enabled)) return true;
        }
        return false;
    }

    private LinearLayout.LayoutParams matchWidthWrapHeight(int topMargin) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        );
        params.topMargin = topMargin;
        return params;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
