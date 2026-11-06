package io.junjo.sdk.internal;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonParseException;
import com.google.gson.JsonParser;
import com.google.gson.JsonPrimitive;
import io.junjo.sdk.JunjoException;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Wire parsing and encoding helpers. Every reader throws {@link JunjoException} with code
 * {@code invalid_wire_data} when a required field is missing or has the wrong JSON type, so a
 * malformed response never surfaces as a raw parse or cast exception.
 *
 * <p>Internal: not part of the supported API.
 */
public final class Json {
    /** Shared encoder. Nulls are kept because several bodies use an explicit null to clear a field. */
    public static final Gson GSON = new GsonBuilder().serializeNulls().disableHtmlEscaping().create();

    private Json() {}

    /** Builds the exception every reader throws for malformed wire data. */
    public static JunjoException wire(String message) {
        return new JunjoException(JunjoException.INVALID_WIRE_DATA, message, null);
    }

    /** Parses a response body that must be a JSON object. */
    public static JsonObject parseObject(String body) {
        JsonElement el = parse(body);
        if (!el.isJsonObject()) throw wire("expected a JSON object");
        return el.getAsJsonObject();
    }

    /** Parses a response body that must be a JSON array. */
    public static JsonArray parseArray(String body) {
        JsonElement el = parse(body);
        if (!el.isJsonArray()) throw wire("expected a JSON array");
        return el.getAsJsonArray();
    }

    /** Parses any JSON document. */
    public static JsonElement parse(String body) {
        try {
            return JsonParser.parseString(body == null ? "" : body);
        } catch (JsonParseException | IllegalStateException e) {
            throw new JunjoException(JunjoException.INVALID_WIRE_DATA, "response body was not valid JSON", e);
        }
    }

    private static JsonElement field(JsonObject o, String name) {
        JsonElement el = o.get(name);
        return el == null || el.isJsonNull() ? null : el;
    }

    /** A required string field. */
    public static String str(JsonObject o, String name) {
        String s = optStr(o, name);
        if (s == null) throw wire("missing string field '" + name + "'");
        return s;
    }

    /** An optional string field; null when absent or JSON null. */
    public static String optStr(JsonObject o, String name) {
        JsonElement el = field(o, name);
        if (el == null) return null;
        if (!el.isJsonPrimitive() || !el.getAsJsonPrimitive().isString()) {
            throw wire("field '" + name + "' is not a string");
        }
        return el.getAsString();
    }

    /** A required boolean field. */
    public static boolean bool(JsonObject o, String name) {
        JsonElement el = field(o, name);
        if (el == null || !el.isJsonPrimitive() || !el.getAsJsonPrimitive().isBoolean()) {
            throw wire("missing boolean field '" + name + "'");
        }
        return el.getAsBoolean();
    }

    /** An optional boolean field. */
    public static boolean optBool(JsonObject o, String name, boolean fallback) {
        JsonElement el = field(o, name);
        if (el == null) return fallback;
        if (!el.isJsonPrimitive() || !el.getAsJsonPrimitive().isBoolean()) {
            throw wire("field '" + name + "' is not a boolean");
        }
        return el.getAsBoolean();
    }

    /** A required integral number field. */
    public static long lng(JsonObject o, String name) {
        JsonElement el = field(o, name);
        if (el == null) throw wire("missing number field '" + name + "'");
        return asLong(el, name);
    }

    /** An optional integral number field. */
    public static long optLong(JsonObject o, String name, long fallback) {
        JsonElement el = field(o, name);
        return el == null ? fallback : asLong(el, name);
    }

    private static long asLong(JsonElement el, String name) {
        if (!el.isJsonPrimitive() || !el.getAsJsonPrimitive().isNumber()) {
            throw wire("field '" + name + "' is not a number");
        }
        try {
            return new BigDecimal(el.getAsString()).longValueExact();
        } catch (ArithmeticException | NumberFormatException e) {
            throw wire("field '" + name + "' is not an integer");
        }
    }

    /** A required timestamp field (ISO 8601). */
    public static Instant instant(JsonObject o, String name) {
        Instant t = optInstant(o, name);
        if (t == null) throw wire("missing timestamp field '" + name + "'");
        return t;
    }

    /** An optional timestamp field (ISO 8601); null when absent or JSON null. */
    public static Instant optInstant(JsonObject o, String name) {
        String s = optStr(o, name);
        if (s == null) return null;
        try {
            return Instant.parse(s);
        } catch (DateTimeParseException e) {
            throw wire("field '" + name + "' is not an ISO 8601 timestamp");
        }
    }

    /** A required object field. */
    public static JsonObject obj(JsonObject o, String name) {
        JsonObject v = optObj(o, name);
        if (v == null) throw wire("missing object field '" + name + "'");
        return v;
    }

    /** An optional object field. */
    public static JsonObject optObj(JsonObject o, String name) {
        JsonElement el = field(o, name);
        if (el == null) return null;
        if (!el.isJsonObject()) throw wire("field '" + name + "' is not an object");
        return el.getAsJsonObject();
    }

    /** A required array field. */
    public static JsonArray arr(JsonObject o, String name) {
        JsonArray v = optArr(o, name);
        if (v == null) throw wire("missing array field '" + name + "'");
        return v;
    }

    /** An optional array field. */
    public static JsonArray optArr(JsonObject o, String name) {
        JsonElement el = field(o, name);
        if (el == null) return null;
        if (!el.isJsonArray()) throw wire("field '" + name + "' is not an array");
        return el.getAsJsonArray();
    }

    /** A required array of objects. */
    public static List<JsonObject> objects(JsonArray a, String name) {
        List<JsonObject> out = new ArrayList<>(a.size());
        for (JsonElement el : a) {
            if (!el.isJsonObject()) throw wire("array '" + name + "' holds a non-object");
            out.add(el.getAsJsonObject());
        }
        return out;
    }

    /** An array of strings; an absent field reads as an empty list. */
    public static List<String> strList(JsonObject o, String name) {
        JsonArray a = optArr(o, name);
        if (a == null) return List.of();
        List<String> out = new ArrayList<>(a.size());
        for (JsonElement el : a) {
            if (!el.isJsonPrimitive() || !el.getAsJsonPrimitive().isString()) {
                throw wire("array '" + name + "' holds a non-string");
            }
            out.add(el.getAsString());
        }
        return List.copyOf(out);
    }

    /** An object field as plain Java values; an absent field reads as an empty map. */
    public static Map<String, Object> map(JsonObject o, String name) {
        JsonObject v = optObj(o, name);
        return v == null ? Map.of() : toJavaMap(v);
    }

    /** Converts an object to an unmodifiable map of plain Java values. */
    public static Map<String, Object> toJavaMap(JsonObject o) {
        Map<String, Object> out = new LinkedHashMap<>();
        for (Map.Entry<String, JsonElement> e : o.entrySet()) {
            out.put(e.getKey(), toJava(e.getValue()));
        }
        return Collections.unmodifiableMap(out);
    }

    /**
     * Converts JSON to plain Java values: objects to maps, arrays to lists, integral numbers that
     * fit a long to {@code Long}, other numbers to {@code Double}, and JSON null to null.
     */
    public static Object toJava(JsonElement el) {
        if (el == null || el.isJsonNull()) return null;
        if (el.isJsonObject()) return toJavaMap(el.getAsJsonObject());
        if (el.isJsonArray()) {
            List<Object> out = new ArrayList<>();
            for (JsonElement item : el.getAsJsonArray()) out.add(toJava(item));
            return Collections.unmodifiableList(out);
        }
        JsonPrimitive p = el.getAsJsonPrimitive();
        if (p.isBoolean()) return p.getAsBoolean();
        if (p.isString()) return p.getAsString();
        BigDecimal d = p.getAsBigDecimal();
        try {
            return d.longValueExact();
        } catch (ArithmeticException e) {
            return d.doubleValue();
        }
    }

    /**
     * Converts a plain Java value (map, iterable, array, string, number, boolean, null, or a
     * {@link JsonElement}) to JSON. Other objects are encoded by Gson's reflective encoder.
     */
    public static JsonElement toJson(Object value) {
        if (value == null) return JsonNull.INSTANCE;
        if (value instanceof JsonElement el) return el;
        if (value instanceof String s) return new JsonPrimitive(s);
        if (value instanceof Number n) return new JsonPrimitive(n);
        if (value instanceof Boolean b) return new JsonPrimitive(b);
        if (value instanceof Character c) return new JsonPrimitive(c);
        if (value instanceof io.junjo.sdk.model.RequestBody rb) return toJson(rb.fields());
        if (value instanceof io.junjo.sdk.model.Context c) return toJson(c.values());
        if (value instanceof java.time.Instant t) return new JsonPrimitive(t.toString());
        if (value instanceof Enum<?> e) return new JsonPrimitive(e.name());
        if (value instanceof Map<?, ?> m) {
            JsonObject o = new JsonObject();
            for (Map.Entry<?, ?> e : m.entrySet()) {
                o.add(String.valueOf(e.getKey()), toJson(e.getValue()));
            }
            return o;
        }
        if (value instanceof Iterable<?> it) {
            JsonArray a = new JsonArray();
            for (Object item : it) a.add(toJson(item));
            return a;
        }
        if (value instanceof Object[] arr) {
            JsonArray a = new JsonArray();
            for (Object item : arr) a.add(toJson(item));
            return a;
        }
        return GSON.toJsonTree(value);
    }

    /** A JSON array of strings. */
    public static JsonArray stringArray(Iterable<String> values) {
        JsonArray a = new JsonArray();
        for (String s : values) a.add(s);
        return a;
    }

    /** Returns the value when it is a string, else null. */
    public static String stringOrNull(Object value) {
        return value instanceof String s ? s : null;
    }
}
