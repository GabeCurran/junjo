package io.junjo.sdk.export;

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
}
