package com.obalivetool.accessibility;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.os.Build;
import android.graphics.Path;
import android.graphics.Rect;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.accessibility.AccessibilityNodeInfo;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

public final class ObaAccessibilityService extends AccessibilityService {
    public static final int CONTROL_PORT = 27191;
    private static final int NOTIFICATION_ID = 27191;
    private static final String NOTIFICATION_CHANNEL_ID = "oba-device-control";
    private static final String VERSION = "0.2.0";
    private static final int SOCKET_TIMEOUT_MS = 6000;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final ExecutorService serverExecutor = Executors.newSingleThreadExecutor();
    private final AtomicBoolean running = new AtomicBoolean(false);
    private volatile ServerSocket serverSocket;
    private final AtomicBoolean destroyed = new AtomicBoolean(false);

    @Override
    public void onCreate() {
        super.onCreate();
        startForeground(NOTIFICATION_ID, buildNotification());
    }

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        destroyed.set(false);
        startServer();
    }

    @Override
    public void onAccessibilityEvent(android.view.accessibility.AccessibilityEvent event) {
        // Commands are received over the local control port. No event collection is needed here.
    }

    @Override
    public void onInterrupt() {
        // Android calls this when accessibility feedback is interrupted.
    }

    @Override
    public void onDestroy() {
        destroyed.set(true);
        stopServer();
        stopForeground(true);
        super.onDestroy();
    }

    private Notification buildNotification() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                NOTIFICATION_CHANNEL_ID,
                "OBA 真机控制",
                NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("保持 OBA 真机控制服务运行");
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) manager.createNotificationChannel(channel);
        }

        Intent launchIntent = new Intent(this, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int pendingFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            pendingFlags |= PendingIntent.FLAG_IMMUTABLE;
        }
        PendingIntent pendingIntent = PendingIntent.getActivity(this, 0, launchIntent, pendingFlags);
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, NOTIFICATION_CHANNEL_ID)
            : new Notification.Builder(this);
        return builder
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle("OBA 真机控制已运行")
            .setContentText("保持此通知可避免 MIUI 清理真机控制服务")
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setCategory(Notification.CATEGORY_SERVICE)
            .build();
    }

    private void startServer() {
        if (!running.compareAndSet(false, true)) return;
        serverExecutor.execute(() -> {
            try {
                ServerSocket socket = new ServerSocket();
                socket.setReuseAddress(true);
                socket.bind(new java.net.InetSocketAddress(
                    InetAddress.getByName("127.0.0.1"),
                    CONTROL_PORT
                ));
                serverSocket = socket;
                while (running.get()) {
                    try (Socket client = socket.accept()) {
                        client.setSoTimeout(SOCKET_TIMEOUT_MS);
                        handleClient(client);
                    } catch (SocketTimeoutException ignored) {
                        // Let the accept loop continue.
            } catch (IOException error) {
                if (running.get()) android.util.Log.w("ObaControl", "Client request failed", error);
            }
        }
    } catch (IOException error) {
        android.util.Log.e("ObaControl", "Unable to start local control server", error);
        if (!destroyed.get()) {
            mainHandler.postDelayed(this::startServer, 3000);
        }
    } finally {
                running.set(false);
                serverSocket = null;
            }
        });
    }

    private void stopServer() {
        running.set(false);
        ServerSocket socket = serverSocket;
        serverSocket = null;
        if (socket != null) {
            try {
                socket.close();
            } catch (IOException ignored) {
                // The server is already stopping.
            }
        }
        serverExecutor.shutdownNow();
    }

    private void handleClient(Socket client) throws IOException {
        InputStream input = client.getInputStream();
        String requestLine = readLine(input);
        if (requestLine == null || requestLine.isEmpty()) return;

        int contentLength = 0;
        String header;
        while ((header = readLine(input)) != null && !header.isEmpty()) {
            int colon = header.indexOf(':');
            if (colon <= 0) continue;
            String name = header.substring(0, colon).trim().toLowerCase(Locale.US);
            if ("content-length".equals(name)) {
                contentLength = Integer.parseInt(header.substring(colon + 1).trim());
            }
        }

        byte[] bodyBytes = new byte[Math.max(0, contentLength)];
        int offset = 0;
        while (offset < bodyBytes.length) {
            int count = input.read(bodyBytes, offset, bodyBytes.length - offset);
            if (count < 0) break;
            offset += count;
        }
        String body = new String(bodyBytes, 0, offset, StandardCharsets.UTF_8);

        JSONObject response;
        int status = 200;
        try {
            if (requestLine.startsWith("GET /health ")) {
                response = success("ready")
                    .put("service", true)
                    .put("version", VERSION)
                    .put("port", CONTROL_PORT);
            } else if (requestLine.startsWith("POST /command ")) {
                response = executeCommand(new JSONObject(body));
                if (!response.optBoolean("ok")) status = 409;
            } else {
                status = 404;
                response = failure("unknown endpoint");
            }
        } catch (Exception error) {
            status = 400;
            response = failure(error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage());
        }
        writeResponse(client.getOutputStream(), status, response);
    }

    private String readLine(InputStream input) throws IOException {
        ByteArrayOutputStream line = new ByteArrayOutputStream();
        int previous = -1;
        int current;
        while ((current = input.read()) >= 0) {
            if (previous == '\r' && current == '\n') {
                byte[] bytes = line.toByteArray();
                int length = Math.max(0, bytes.length - 1);
                return new String(bytes, 0, length, StandardCharsets.UTF_8);
            }
            line.write(current);
            previous = current;
            if (line.size() > 16 * 1024) throw new IOException("HTTP header line is too long");
        }
        if (line.size() == 0) return null;
        return line.toString("UTF-8");
    }

    private JSONObject executeCommand(JSONObject command) throws Exception {
        String action = command.optString("action", "");
        if ("tap".equals(action)) {
            float x = (float) command.getDouble("x");
            float y = (float) command.getDouble("y");
            return gesture(x, y, x, y, 60) ? success("tap completed") : failure("tap failed");
        }
        if ("swipe".equals(action)) {
            float fromX = (float) command.getDouble("fromX");
            float fromY = (float) command.getDouble("fromY");
            float toX = (float) command.getDouble("toX");
            float toY = (float) command.getDouble("toY");
            long duration = Math.max(50, Math.min(5000, command.optLong("durationMs", 300)));
            return gesture(fromX, fromY, toX, toY, duration)
                ? success("swipe completed")
                : failure("swipe failed");
        }
        if ("global".equals(action)) {
            String key = command.optString("key", "").toUpperCase(Locale.US);
            int globalAction;
            if ("BACK".equals(key)) globalAction = GLOBAL_ACTION_BACK;
            else if ("HOME".equals(key)) globalAction = GLOBAL_ACTION_HOME;
            else if ("APP_SWITCH".equals(key) || "RECENTS".equals(key)) {
                globalAction = GLOBAL_ACTION_RECENTS;
            } else {
                return failure("unsupported global action");
            }
            return runGlobalAction(globalAction)
                ? success("global action completed")
                : failure("global action failed");
        }
        if ("set_text".equals(action) || "clear_text".equals(action)) {
            String text = "clear_text".equals(action) ? "" : command.optString("text", "");
            return setFocusedText(text)
                ? success("text updated")
                : failure("no editable focused field");
        }
        if ("dump_hierarchy".equals(action)) {
            String hierarchy = dumpHierarchy();
            if (hierarchy == null || hierarchy.isEmpty()) return failure("no active accessibility window");
            return success("hierarchy captured").put("hierarchy", hierarchy);
        }
        return failure("unsupported action");
    }

    /** Read the active window without registering UiAutomation on the device. */
    private String dumpHierarchy() throws InterruptedException {
        CountDownLatch completed = new CountDownLatch(1);
        AtomicReference<String> result = new AtomicReference<>();
        mainHandler.post(() -> {
            AccessibilityNodeInfo root = null;
            try {
                root = getRootInActiveWindow();
                if (root != null) {
                    StringBuilder xml = new StringBuilder(64 * 1024);
                    xml.append("<?xml version=\"1.0\" encoding=\"UTF-8\"?><hierarchy>");
                    appendNodeXml(root, xml, new int[] {0});
                    xml.append("</hierarchy>");
                    result.set(xml.toString());
                }
            } catch (Throwable throwable) {
                android.util.Log.w("ObaControl", "Unable to dump accessibility hierarchy", throwable);
            } finally {
                if (root != null) root.recycle();
                completed.countDown();
            }
        });
        completed.await(3500, TimeUnit.MILLISECONDS);
        return result.get();
    }

    private void appendNodeXml(AccessibilityNodeInfo node, StringBuilder xml, int[] nextIndex) {
        Rect bounds = new Rect();
        node.getBoundsInScreen(bounds);
        xml.append("<node")
            .append(" index=\"").append(nextIndex[0]++).append("\"")
            .append(" text=\"").append(escapeXml(node.getText())).append("\"")
            .append(" resource-id=\"").append(escapeXml(safeViewId(node))).append("\"")
            .append(" class=\"").append(escapeXml(node.getClassName())).append("\"")
            .append(" package=\"").append(escapeXml(node.getPackageName())).append("\"")
            .append(" content-desc=\"").append(escapeXml(node.getContentDescription())).append("\"")
            .append(" clickable=\"").append(node.isClickable()).append("\"")
            .append(" enabled=\"").append(node.isEnabled()).append("\"")
            .append(" focused=\"").append(node.isFocused()).append("\"")
            .append(" scrollable=\"").append(node.isScrollable()).append("\"")
            .append(" selected=\"").append(node.isSelected()).append("\"")
            .append(" bounds=\"[").append(bounds.left).append(',').append(bounds.top)
            .append("][").append(bounds.right).append(',').append(bounds.bottom).append("]\"");

        int childCount = node.getChildCount();
        if (childCount == 0) {
            xml.append("/>");
            return;
        }
        xml.append('>');
        for (int childIndex = 0; childIndex < childCount; childIndex++) {
            AccessibilityNodeInfo child = node.getChild(childIndex);
            if (child == null) continue;
            try {
                appendNodeXml(child, xml, nextIndex);
            } finally {
                child.recycle();
            }
        }
        xml.append("</node>");
    }

    private String safeViewId(AccessibilityNodeInfo node) {
        try {
            String value = node.getViewIdResourceName();
            return value == null ? "" : value;
        } catch (Throwable ignored) {
            return "";
        }
    }

    private String escapeXml(CharSequence value) {
        if (value == null) return "";
        return value.toString()
            .replace("&", "&amp;")
            .replace("\"", "&quot;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
            .replace("'", "&apos;");
    }

    private boolean gesture(float fromX, float fromY, float toX, float toY, long durationMs)
        throws InterruptedException {
        CountDownLatch completed = new CountDownLatch(1);
        AtomicBoolean result = new AtomicBoolean(false);
        mainHandler.post(() -> {
            Path path = new Path();
            path.moveTo(fromX, fromY);
            if (fromX != toX || fromY != toY) path.lineTo(toX, toY);
            GestureDescription gesture = new GestureDescription.Builder()
                .addStroke(new GestureDescription.StrokeDescription(path, 0, durationMs))
                .build();
            boolean dispatched = dispatchGesture(
                gesture,
                new GestureResultCallback() {
                    @Override
                    public void onCompleted(GestureDescription gestureDescription) {
                        result.set(true);
                        completed.countDown();
                    }

                    @Override
                    public void onCancelled(GestureDescription gestureDescription) {
                        completed.countDown();
                    }
                },
                null
            );
            if (!dispatched) completed.countDown();
        });
        completed.await(Math.max(2500, durationMs + 1500), TimeUnit.MILLISECONDS);
        return result.get();
    }

    private boolean runGlobalAction(int action) throws InterruptedException {
        CountDownLatch completed = new CountDownLatch(1);
        AtomicBoolean result = new AtomicBoolean(false);
        mainHandler.post(() -> {
            result.set(performGlobalAction(action));
            completed.countDown();
        });
        completed.await(2500, TimeUnit.MILLISECONDS);
        return result.get();
    }

    private boolean setFocusedText(String text) throws InterruptedException {
        CountDownLatch completed = new CountDownLatch(1);
        AtomicBoolean result = new AtomicBoolean(false);
        AtomicReference<Throwable> error = new AtomicReference<>();
        mainHandler.post(() -> {
            AccessibilityNodeInfo root = null;
            AccessibilityNodeInfo target = null;
            try {
                root = getRootInActiveWindow();
                if (root == null) return;
                target = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
                if (target == null || !target.isEditable()) {
                    if (target != null) target.recycle();
                    target = findEditableNode(root);
                }
                if (target == null) return;
                Bundle arguments = new Bundle();
                arguments.putCharSequence(
                    AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE,
                    text
                );
                result.set(target.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments));
            } catch (Throwable throwable) {
                error.set(throwable);
            } finally {
                if (target != null) target.recycle();
                if (root != null) root.recycle();
                completed.countDown();
            }
        });
        completed.await(3500, TimeUnit.MILLISECONDS);
        if (error.get() != null) android.util.Log.w("ObaControl", "Unable to set text", error.get());
        return result.get();
    }

    private AccessibilityNodeInfo findEditableNode(AccessibilityNodeInfo node) {
        int childCount = node.getChildCount();
        for (int index = 0; index < childCount; index++) {
            AccessibilityNodeInfo child = node.getChild(index);
            if (child == null) continue;
            if (child.isEditable() && (child.isFocused() || child.isAccessibilityFocused())) {
                return child;
            }
            AccessibilityNodeInfo match = findEditableNode(child);
            child.recycle();
            if (match != null) return match;
        }
        return null;
    }

    private JSONObject success(String message) throws Exception {
        return new JSONObject().put("ok", true).put("message", message);
    }

    private JSONObject failure(String message) {
        try {
            return new JSONObject().put("ok", false).put("message", message);
        } catch (Exception ignored) {
            return new JSONObject();
        }
    }

    private void writeResponse(OutputStream output, int status, JSONObject response) throws IOException {
        byte[] payload = response.toString().getBytes(StandardCharsets.UTF_8);
        String reason = status == 200 ? "OK" : status == 404 ? "Not Found" : "Bad Request";
        String headers = "HTTP/1.1 " + status + " " + reason + "\r\n"
            + "Content-Type: application/json; charset=utf-8\r\n"
            + "Content-Length: " + payload.length + "\r\n"
            + "Connection: close\r\n\r\n";
        output.write(headers.getBytes(StandardCharsets.US_ASCII));
        output.write(payload);
        output.flush();
    }
}
