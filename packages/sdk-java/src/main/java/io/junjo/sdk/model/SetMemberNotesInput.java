package io.junjo.sdk.model;

import java.util.LinkedHashMap;
import java.util.Map;

/** Body of a member notes change. Only the notes set on the builder are sent; the other is kept. */
public final class SetMemberNotesInput extends RequestBody {
    private SetMemberNotesInput(Map<String, Object> fields) {
        super(fields);
    }

    public static Builder builder() {
        return new Builder();
    }

    /** Builds a {@link SetMemberNotesInput}. */
    public static final class Builder {
        private final Map<String, Object> f = new LinkedHashMap<>();

        private Builder() {}

        /** Null clears the public note. */
        public Builder notesPublic(String note) {
            f.put("notesPublic", note);
            return this;
        }

        /** Null clears the staff note. */
        public Builder notesPrivate(String note) {
            f.put("notesPrivate", note);
            return this;
        }

        /** @throws IllegalStateException when neither note was set */
        public SetMemberNotesInput build() {
            if (f.isEmpty()) throw new IllegalStateException("set at least one note");
            return new SetMemberNotesInput(f);
        }
    }
}
