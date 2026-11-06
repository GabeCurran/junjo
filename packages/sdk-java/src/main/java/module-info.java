/**
 * The Junjo Java SDK. Only the API packages are exported; {@code io.junjo.sdk.internal} is not
 * part of the supported API.
 */
module io.junjo.sdk {
    requires java.net.http;
    requires com.google.gson;

    exports io.junjo.sdk;
    exports io.junjo.sdk.events;
    exports io.junjo.sdk.export;
    exports io.junjo.sdk.mirror;
    exports io.junjo.sdk.model;
    exports io.junjo.sdk.permissions;
    exports io.junjo.sdk.queue;
}
