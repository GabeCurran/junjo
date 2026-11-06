package io.junjo.sdk.export;

import io.junjo.sdk.model.Context;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * One line of an export.
 *
 * @param kind the record kind ({@code header}, {@code end}, or a data kind)
 * @param fields every field of the line as plain Java values, {@code kind} included
 */
public record ExportRecord(String kind, Map<String, Object> fields, String json) {
    /**
     * @return the field's value, or null
     */
    public Object get(String name) {
        return fields.get(name);
    }

    /**
     * The {@code context} of one element of a {@code role} record's {@code entries} or a
     * {@code member} record's {@code overrides}, as a {@link Context}: {@link Context#GLOBAL}
     * when the element has none or is not an object. Non-string values are ignored.
     */
    public static Context context(Object element) {
        if (!(element instanceof Map<?, ?> m) || !(m.get("context") instanceof Map<?, ?> raw)) return Context.GLOBAL;
        Map<String, String> values = new LinkedHashMap<>();
        raw.forEach((k, v) -> {
            if (k instanceof String key && v instanceof String value) values.put(key, value);
        });
        return Context.fromWire(values);
    }
}
