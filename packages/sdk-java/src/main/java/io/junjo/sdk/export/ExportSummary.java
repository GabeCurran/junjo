package io.junjo.sdk.export;

import java.time.Instant;
import java.util.Map;

/**
 * What a completed, validated export reported.
 *
 * @param position the stream position read before any record; replay the game stream from it to
 *     catch changes made while the export ran
 * @param counts records per kind, as the end record stated and the reader verified
 */
public record ExportSummary(String gameId, String position, Instant exportedAt, Map<String, Long> counts) {}
