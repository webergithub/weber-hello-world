/* 由 scripts/build-dsh-llm.mjs 从 vendor/dsh-llm 生成，请勿手工修改。包含 DeepSeek Harness（MIT，Copyright (c) 2026 DeepSeek）与 eventsource-parser（MIT）的代码。 */
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
//#region vendor/dsh-llm/upstream/llm/error.ts
/**
* Harness error base with a stable machine-routable code and chained cause.
* Package errors extend it so tool results and replay can retain failure class.
* @module @deepseek-ai/dsh-llm/error
*/
/**
* Base class for all harness errors. Carries a `code` (stable, programmatic —
* e.g. `NO_ADAPTER`, `INVALID_ARGS`) distinct from the
* human-readable `message`, and supports `cause` chaining via the standard
* `ErrorOptions`. `name` defaults to the subclass constructor name.
*/
var HarnessError = class extends Error {
	/** Stable machine-routable failure class (e.g. `RATE_LIMIT`); route on this, never by parsing `message`. */
	code;
	constructor(message, code, options) {
		super(message, options);
		this.code = code;
		this.name = new.target.name;
	}
};
/**
* Canonical provider-neutral code for a response that completed normally but
* carried no content blocks at all. Providers occasionally emit a degenerate
* completion (a terminal stop with zero output); adapters classify it as this
* failure instead of yielding an empty assistant message, because an empty
* message silently ends the turn with nothing for the user or the loop to act
* on. The attempt produced nothing durable, so retry policy treats it as safe
* to repeat.
*/
const EMPTY_RESPONSE_CODE = "EMPTY_RESPONSE";
/** Structured codes and plain phrases that explicitly name a context bound being exceeded. */
const STRUCTURED_CONTEXT_OVERFLOW = new RegExp(String.raw`(?:^|[^a-z0-9])context[\s_-](?:length|window)[\s_-]` + String.raw`(?:exceed(?:ed|s)?|overflow(?:ed)?|limit[\s_-]exceeded)(?:$|[^a-z0-9])`, "i");
/** Request-size wording that ties "too large" directly to model context capacity. */
const TOO_LARGE_FOR_CONTEXT = new RegExp(String.raw`\b(?:request|prompt|input|messages?)\s+(?:is\s+|are\s+)?` + String.raw`too\s+(?:large|long)\s+for\s+(?:(?:this|the)\s+)?` + String.raw`(?:model(?:'s)?\s+)?context(?:\s+window)?\b`, "i");
/** "Exceeds" wording is safe only when its object is explicitly the model context. */
const EXCEEDS_MODEL_CONTEXT = new RegExp(String.raw`\b(?:input|prompt|request|messages?)\b.{0,40}` + String.raw`\b(?:exceed(?:s|ed)?|overflows?|is\s+larger\s+than)\b.{0,40}` + String.raw`\b(?:the\s+)?(?:model(?:'s)?\s+)?context(?:\s+(?:length|window))?\b`, "i");
/**
* Recognize the context-overflow wording used by OpenAI-compatible providers
* and library adapters. Adapters pass all available provider code, type, and
* message text so both thrown and in-band delivery styles share one classifier.
* @param detail - provider error code/type/message text joined into one string.
* @returns true when the detail identifies a request exceeding the model context window.
*/
function isContextWindowExceededError(detail) {
	return STRUCTURED_CONTEXT_OVERFLOW.test(detail) || /\b(?:maximum|max)(?:\s+(?:allowed|supported))?\s+context\s+(?:length|window)\b/i.test(detail) || TOO_LARGE_FOR_CONTEXT.test(detail) || /\b(?:input|prompt|request)\s+(?:is\s+)?too\s+(?:long|large)\s+for\s+(?:this|the)\s+model\b/i.test(detail) || EXCEEDS_MODEL_CONTEXT.test(detail);
}
/**
* Recognize provider wording that identifies an exhausted account quota rather
* than a transient request-rate limit.
* @param detail - provider error code/type/message text joined into one string.
* @returns true only for terminal quota, balance, credit, budget, or usage-limit wording.
*/
function isQuotaExceededError(detail) {
	return /\binsufficient[\s_-]+(?:quota|balance|credits?)\b/i.test(detail) || /\b(?:quota|usage[\s_-]+limit)[\s_-]+(?:exceeded|exhausted|reached)\b/i.test(detail) || /\bexceed(?:ed|s)?[\s_-]+(?:(?:your|the)[\s_-]+)?(?:current[\s_-]+)?quota\b/i.test(detail) || /\b(?:balance|credits?)[\s_-]+(?:exhausted|depleted)\b/i.test(detail) || /\bout[\s_-]+of[\s_-]+(?:credits?|budget)\b/i.test(detail);
}
/**
* Render a thrown value with its full `cause` chain and AggregateError
* members, so transport wrappers like undici's `TypeError: fetch failed`
* surface the underlying failure instead of masking it. Plain structured
* failures render their own data-backed `message`. Diagnostic-surface
* rendering only (messages, notices, logs) — never parse the result; route on
* {@link HarnessError.code}.
* @param value - the caught value (`unknown` in catch clauses).
* @returns the outermost message first, each cause appended with `: ` (skipped
* when it repeats the wrapper message verbatim), and AggregateError members
* bracketed and `; `-joined.
*/
function errorChain(value) {
	const path = /* @__PURE__ */ new Set();
	const render = (current) => {
		if (path.has(current)) return "<circular cause>";
		path.add(current);
		try {
			if (!(current instanceof Error)) {
				if (typeof current === "object" && current !== null) {
					const descriptor = Object.getOwnPropertyDescriptor(current, "message");
					if (descriptor !== void 0 && "value" in descriptor && typeof descriptor.value === "string") return descriptor.value;
				}
				return String(current);
			}
			const message = current.message === "" ? current.name : current.message;
			const members = current instanceof AggregateError && current.errors.length > 0 ? ` [${current.errors.map(render).join("; ")}]` : "";
			const causeText = current.cause === void 0 || current.cause === null ? "" : render(current.cause);
			return `${message}${members}${causeText === "" || causeText === message ? "" : `: ${causeText}`}`;
		} catch {
			return "<unrenderable value>";
		} finally {
			path.delete(current);
		}
	};
	return render(value);
}
//#endregion
//#region vendor/dsh-llm/upstream/llm/llm-error.ts
/**
* Typed error for LLM-related failures. Extends {@link HarnessError}, so the
* `code` string (e.g. `AUTH`, `RATE_LIMIT`, `NO_ADAPTER`) is shared taxonomy.
*/
var LlmError = class extends HarnessError {
	/** Serializable facts retained beside this live Error. */
	failure;
	/**
	* @param message - non-empty human-readable failure summary.
	* @param code - non-empty stable provider-neutral machine code.
	* @param options - optional cause and validated serializable provider facts.
	*/
	constructor(message, code, options) {
		if (typeof message !== "string" || message.length === 0) throw new Error("LlmError message must be a non-empty string");
		if (typeof code !== "string" || code.length === 0) throw new Error("LlmError code must be a non-empty string");
		if (options?.status !== void 0 && (!Number.isInteger(options.status) || options.status < 100 || options.status > 599)) throw new Error("LlmError status must be an integer from 100 through 599");
		if (options?.providerRetryAfterMs !== void 0 && (!Number.isFinite(options.providerRetryAfterMs) || options.providerRetryAfterMs <= 0)) throw new Error("LlmError providerRetryAfterMs must be a positive finite number");
		if (options?.requestId !== void 0 && (typeof options.requestId !== "string" || options.requestId.length === 0)) throw new Error("LlmError requestId must be a non-empty string");
		super(message, code, options);
		this.name = "LlmError";
		this.failure = Object.freeze({
			message,
			code,
			...options?.status === void 0 ? {} : { status: options.status },
			...options?.providerRetryAfterMs === void 0 ? {} : { providerRetryAfterMs: options.providerRetryAfterMs },
			...options?.requestId === void 0 ? {} : { requestId: options.requestId },
			...options?.offloadImages === void 0 ? {} : { offloadImages: options.offloadImages }
		});
	}
};
//#endregion
//#region vendor/dsh-llm/upstream/brand/index.ts
/**
* Apply a compile-time string brand without changing the value.
* @param value - string admitted by the domain that owns the target brand.
* @returns the same string with the requested compile-time brand.
*/
function brandString(value) {
	return value;
}
//#endregion
//#region vendor/dsh-llm/upstream/llm/brand.ts
/**
* dsh-llm's owned branded ids: tool-call correlation and provider request
* diagnostics.
*
* The `Branded<B>` primitive and stateless constructor live in
* `@deepseek-ai/dsh-brand` so every owner of a cross-boundary id can brand it
* without depending on dsh-llm; see that package's README for the
* nominal-typing policy.
*
* @module @deepseek-ai/dsh-llm/brand
*/
/**
* Brand a string as a {@link ToolCallId}.
* @param id - the provider-issued or synthesized call id.
* @returns the same string with the tool-call-id brand.
*/
function ToolCallId(id) {
	return brandString(id);
}
/**
* Brand a provider-issued request identifier.
* @param id - the opaque provider-issued string.
* @returns the same string, branded; no validation is performed.
*/
function ProviderRequestId(id) {
	return brandString(id);
}
//#endregion
//#region vendor/dsh-llm/upstream/timeout/index.ts
/**
* Shared timeout arithmetic, signal fusion, and classification. The library
* only notifies through abort signals; each capability still owns the mechanism
* that stops its work and translates timeout reasons into public outcomes.
* @module @deepseek-ai/dsh-timeout
*/
/**
* Internal abort reason carrying a capability-owned code and elapsed deadline.
* Providers translate it through {@link timeoutOf} before returning to callers.
*/
var TimeoutReason = class extends Error {
	code;
	timeoutMs;
	name = "TimeoutReason";
	/**
	* @param code Capability-owned timeout code (e.g. `BASH_TIMEOUT`).
	* @param timeoutMs The deadline that elapsed, in milliseconds.
	*/
	constructor(code, timeoutMs) {
		super(`${code} after ${timeoutMs}ms`);
		this.code = code;
		this.timeoutMs = timeoutMs;
	}
};
/** Largest delay Node schedules without clamping it to one millisecond. */
const MAX_TIMER_DELAY_MS = 2147483647;
function assertTimerDelay(timeoutMs, name) {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) throw new Error(`${name} must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
}
/**
* Create a rearmable idle watchdog for an async iterator. The timer exists only
* while {@link IdleWatchdog.next} is outstanding, so consumer think time does
* not count as provider idle time. The returned signal is stable for the whole
* call and only notifies; the iterator must observe it to release the resources
* of a demand the deadline abandoned.
*
* @param upstream - caller cancellation fused into the stable signal.
* @param timeoutMs - positive finite idle interval in milliseconds.
* @param code - capability-owned code carried by the timeout reason.
* @returns a stable signal, guarded next operation, and timer disposer.
*/
function idleWatchdog(upstream, timeoutMs, code) {
	assertTimerDelay(timeoutMs, "idleWatchdog timeoutMs");
	const timeout = new AbortController();
	const signal = upstream === void 0 ? timeout.signal : AbortSignal.any([upstream, timeout.signal]);
	const reason = new TimeoutReason(code, timeoutMs);
	let timer;
	let outstanding = false;
	let disposed = false;
	const arm = () => {
		if (timer !== void 0) clearTimeout(timer);
		timer = setTimeout(() => {
			timeout.abort(reason);
		}, timeoutMs);
	};
	return {
		signal,
		async next(iterator) {
			if (disposed) throw new Error("idleWatchdog is disposed");
			if (outstanding) throw new Error("idleWatchdog next is already outstanding");
			outstanding = true;
			arm();
			const expired = Promise.withResolvers();
			const onAbort = () => {
				expired.reject(reason);
			};
			timeout.signal.addEventListener("abort", onAbort, { once: true });
			try {
				return await Promise.race([iterator.next().finally(() => {
					timeout.signal.removeEventListener("abort", onAbort);
				}), expired.promise]);
			} finally {
				clearTimeout(timer);
				timer = void 0;
				outstanding = false;
			}
		},
		pulse() {
			if (disposed || !outstanding) return;
			arm();
		},
		[Symbol.dispose]() {
			if (disposed) return;
			disposed = true;
			if (timer !== void 0) clearTimeout(timer);
			timer = void 0;
		}
	};
}
/**
* Recover a timeout reason from a reason-bearing object. Supplying `code`
* distinguishes this deadline from a nested upstream deadline; a foreign code
* follows the ordinary cancellation path.
*
* @param x An {@link AbortSignal} or any `{ reason }` carrier (e.g. a caught abort error).
* @param code When provided, only a {@link TimeoutReason} with this exact `code` matches.
* @returns The matching {@link TimeoutReason}, else `undefined`.
*/
function timeoutOf(x, code) {
	const reason = x.reason;
	if (!(reason instanceof TimeoutReason)) return void 0;
	return code === void 0 || reason.code === code ? reason : void 0;
}
//#endregion
//#region vendor/dsh-llm/upstream/llm-deepseek/messages-api.ts
/**
* Resolve the API root without duplicating an explicit provider version path.
* @param baseURL - validated configured endpoint root.
* @returns the root beneath which Messages resources are exposed.
*/
function messagesApiRoot(baseURL) {
	const base = baseURL.replace(/\/+$/u, "");
	return new URL(base).pathname.endsWith("/v1") ? base : `${base}/v1`;
}
//#endregion
//#region node_modules/eventsource-parser/dist/index.js
var ParseError = class extends Error {
	constructor(message, options) {
		super(message), this.name = "ParseError", this.type = options.type, this.field = options.field, this.value = options.value, this.line = options.line;
	}
};
const LF = 10;
const CR = 13;
const SPACE = 32;
function noop(_arg) {}
function createParser(config) {
	if (typeof config == "function") throw new TypeError("`config` must be an object, got a function instead. Did you mean `createParser({onEvent: fn})`?");
	const { onEvent = noop, onError = noop, onRetry = noop, onComment, maxBufferSize } = config, pendingFragments = [];
	let pendingFragmentsLength = 0, isFirstChunk = !0, id, data = "", dataLines = 0, eventType, terminated = !1;
	function feed(chunk) {
		if (terminated) throw new Error("Cannot feed parser: it was terminated after exceeding the configured max buffer size. Call `reset()` to resume parsing.");
		if (isFirstChunk && (isFirstChunk = !1, chunk.charCodeAt(0) === 239 && chunk.charCodeAt(1) === 187 && chunk.charCodeAt(2) === 191 && (chunk = chunk.slice(3))), pendingFragments.length === 0) {
			const trailing2 = processLines(chunk);
			trailing2 !== "" && (pendingFragments.push(trailing2), pendingFragmentsLength = trailing2.length), checkBufferSize();
			return;
		}
		if (chunk.indexOf(`
`) === -1 && chunk.indexOf("\r") === -1) {
			pendingFragments.push(chunk), pendingFragmentsLength += chunk.length, checkBufferSize();
			return;
		}
		pendingFragments.push(chunk);
		const input = pendingFragments.join("");
		pendingFragments.length = 0, pendingFragmentsLength = 0;
		const trailing = processLines(input);
		trailing !== "" && (pendingFragments.push(trailing), pendingFragmentsLength = trailing.length), checkBufferSize();
	}
	function checkBufferSize() {
		maxBufferSize !== void 0 && (pendingFragmentsLength + data.length <= maxBufferSize || (terminated = !0, pendingFragments.length = 0, pendingFragmentsLength = 0, id = void 0, data = "", dataLines = 0, eventType = void 0, onError(new ParseError(`Buffered data exceeded max buffer size of ${maxBufferSize} characters`, { type: "max-buffer-size-exceeded" }))));
	}
	function processLines(chunk) {
		let searchIndex = 0;
		if (chunk.indexOf("\r") === -1) {
			let lfIndex = chunk.indexOf(`
`, searchIndex);
			for (; lfIndex !== -1;) {
				if (searchIndex === lfIndex) {
					dataLines > 0 && onEvent({
						id,
						event: eventType,
						data
					}), id = void 0, data = "", dataLines = 0, eventType = void 0, searchIndex = lfIndex + 1, lfIndex = chunk.indexOf(`
`, searchIndex);
					continue;
				}
				const firstCharCode = chunk.charCodeAt(searchIndex);
				if (isDataPrefix(chunk, searchIndex, firstCharCode)) {
					const valueStart = chunk.charCodeAt(searchIndex + 5) === SPACE ? searchIndex + 6 : searchIndex + 5, value = chunk.slice(valueStart, lfIndex);
					if (dataLines === 0 && chunk.charCodeAt(lfIndex + 1) === LF) {
						onEvent({
							id,
							event: eventType,
							data: value
						}), id = void 0, data = "", eventType = void 0, searchIndex = lfIndex + 2, lfIndex = chunk.indexOf(`
`, searchIndex);
						continue;
					}
					data = dataLines === 0 ? value : `${data}
${value}`, dataLines++;
				} else isEventPrefix(chunk, searchIndex, firstCharCode) ? eventType = chunk.slice(chunk.charCodeAt(searchIndex + 6) === SPACE ? searchIndex + 7 : searchIndex + 6, lfIndex) || void 0 : parseLine(chunk, searchIndex, lfIndex);
				searchIndex = lfIndex + 1, lfIndex = chunk.indexOf(`
`, searchIndex);
			}
			return chunk.slice(searchIndex);
		}
		for (; searchIndex < chunk.length;) {
			const crIndex = chunk.indexOf("\r", searchIndex), lfIndex = chunk.indexOf(`
`, searchIndex);
			let lineEnd = -1;
			if (crIndex !== -1 && lfIndex !== -1 ? lineEnd = crIndex < lfIndex ? crIndex : lfIndex : crIndex !== -1 ? crIndex === chunk.length - 1 ? lineEnd = -1 : lineEnd = crIndex : lfIndex !== -1 && (lineEnd = lfIndex), lineEnd === -1) break;
			parseLine(chunk, searchIndex, lineEnd), searchIndex = lineEnd + 1, chunk.charCodeAt(searchIndex - 1) === CR && chunk.charCodeAt(searchIndex) === LF && searchIndex++;
		}
		return chunk.slice(searchIndex);
	}
	function parseLine(chunk, start, end) {
		if (start === end) {
			dispatchEvent();
			return;
		}
		const firstCharCode = chunk.charCodeAt(start);
		if (isDataPrefix(chunk, start, firstCharCode)) {
			const valueStart = chunk.charCodeAt(start + 5) === SPACE ? start + 6 : start + 5, value2 = chunk.slice(valueStart, end);
			data = dataLines === 0 ? value2 : `${data}
${value2}`, dataLines++;
			return;
		}
		if (isEventPrefix(chunk, start, firstCharCode)) {
			eventType = chunk.slice(chunk.charCodeAt(start + 6) === SPACE ? start + 7 : start + 6, end) || void 0;
			return;
		}
		if (firstCharCode === 105 && chunk.charCodeAt(start + 1) === 100 && chunk.charCodeAt(start + 2) === 58) {
			const value2 = chunk.slice(chunk.charCodeAt(start + 3) === SPACE ? start + 4 : start + 3, end);
			value2.includes("\0") || (id = value2);
			return;
		}
		if (firstCharCode === 58) {
			if (onComment) {
				const line2 = chunk.slice(start, end);
				onComment(line2.slice(chunk.charCodeAt(start + 1) === SPACE ? 2 : 1));
			}
			return;
		}
		const line = chunk.slice(start, end), fieldSeparatorIndex = line.indexOf(":");
		if (fieldSeparatorIndex === -1) {
			processField(line, "", line);
			return;
		}
		const field = line.slice(0, fieldSeparatorIndex), offset = line.charCodeAt(fieldSeparatorIndex + 1) === SPACE ? 2 : 1;
		processField(field, line.slice(fieldSeparatorIndex + offset), line);
	}
	function processField(field, value, line) {
		switch (field) {
			case "event":
				eventType = value || void 0;
				break;
			case "data":
				data = dataLines === 0 ? value : `${data}
${value}`, dataLines++;
				break;
			case "id":
				value.includes("\0") || (id = value);
				break;
			case "retry":
				/^\d+$/.test(value) ? onRetry(parseInt(value, 10)) : onError(new ParseError(`Invalid \`retry\` value: "${value}"`, {
					type: "invalid-retry",
					value,
					line
				}));
				break;
			default: onError(new ParseError(`Unknown field "${field.length > 20 ? `${field.slice(0, 20)}\u2026` : field}"`, {
				type: "unknown-field",
				field,
				value,
				line
			}));
		}
	}
	function dispatchEvent() {
		dataLines > 0 && onEvent({
			id,
			event: eventType,
			data
		}), id = void 0, data = "", dataLines = 0, eventType = void 0;
	}
	function reset(options = {}) {
		if (options.consume && pendingFragments.length > 0) {
			const incompleteLine = pendingFragments.join("");
			parseLine(incompleteLine, 0, incompleteLine.length);
		}
		isFirstChunk = !0, id = void 0, data = "", dataLines = 0, eventType = void 0, pendingFragments.length = 0, pendingFragmentsLength = 0, terminated = !1;
	}
	return {
		feed,
		reset
	};
}
function isDataPrefix(chunk, i, firstCharCode) {
	return firstCharCode === 100 && chunk.charCodeAt(i + 1) === 97 && chunk.charCodeAt(i + 2) === 116 && chunk.charCodeAt(i + 3) === 97 && chunk.charCodeAt(i + 4) === 58;
}
function isEventPrefix(chunk, i, firstCharCode) {
	return firstCharCode === 101 && chunk.charCodeAt(i + 1) === 118 && chunk.charCodeAt(i + 2) === 101 && chunk.charCodeAt(i + 3) === 110 && chunk.charCodeAt(i + 4) === 116 && chunk.charCodeAt(i + 5) === 58;
}
//#endregion
//#region node_modules/eventsource-parser/dist/stream.js
var EventSourceParserStream = class extends TransformStream {
	constructor({ onError, onRetry, onComment, maxBufferSize } = {}) {
		let parser;
		super({
			start(controller) {
				parser = createParser({
					onEvent: (event) => {
						controller.enqueue(event);
					},
					onError(error) {
						typeof onError == "function" && onError(error), (onError === "terminate" || error.type === "max-buffer-size-exceeded") && controller.error(error);
					},
					onRetry,
					onComment,
					maxBufferSize
				});
			},
			transform(chunk) {
				parser.feed(chunk);
			}
		});
	}
};
//#endregion
//#region vendor/dsh-llm/upstream/llm-deepseek/replay.ts
/** Minimal native thinking metadata; durable Harness blocks own all response text. */
/** Reject malformed JSON objects at provider and durable-data reads.
* @param value - untrusted decoded JSON.
* @param code - owning failure category.
* @returns the validated object.
*/
function object(value, code = "MALFORMED_RESPONSE") {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new LlmError("DeepSeek Messages expected a JSON object", code);
	return value;
}
/** Construct response metadata without duplicating the assistant text.
* @param model - requested model identity.
* @param blocks - metadata in emitted block order.
* @returns the versioned envelope persisted by the existing assembler.
*/
function replayState(model, blocks) {
	return {
		response: {
			kind: "deepseek-messages",
			version: 1,
			model
		},
		blocks
	};
}
//#endregion
//#region vendor/dsh-llm/upstream/llm-deepseek/transport.ts
/** Normalize HTTP and in-band Messages errors into provider-neutral failures. */
/** Classify a provider error without trusting arbitrary response fields.
* @param raw - decoded response or in-band error event.
* @param status - HTTP status when the error preceded streaming.
* @param headers - response headers for retry delay and request identity.
* @returns a stable error consumed by LlmRuntime and llm-retry.
*/
function providerError(raw, status, headers) {
	const envelope = typeof raw === "object" && raw !== null ? raw : {};
	const error = typeof envelope.error === "object" && envelope.error !== null ? envelope.error : {};
	const message = typeof error.message === "string" ? error.message : `DeepSeek Messages request failed (${status ?? "stream error"})`;
	const type = typeof error.type === "string" ? error.type : "";
	const detail = `${type} ${typeof error.code === "string" ? error.code : ""} ${message}`;
	let code;
	if (status === 401 || status === 403 || ["authentication_error", "permission_error"].includes(type)) code = "AUTH";
	else if (isQuotaExceededError(detail) || status === 402) code = "QUOTA";
	else if (status === 429 || type === "rate_limit_error") code = "RATE_LIMIT";
	else if (isContextWindowExceededError(detail)) code = "CONTEXT_WINDOW_EXCEEDED";
	else if (status === 400 || status === 413 || type === "invalid_request_error") code = "INVALID_REQUEST";
	else if (status !== void 0 && status >= 500 || ["api_error", "overloaded_error"].includes(type)) code = "SERVER";
	else code = status === void 0 ? "SERVER" : `HTTP_${status}`;
	const retry = headers?.get("retry-after");
	const delay = retry == null ? NaN : /^\d+(?:\.\d+)?$/u.test(retry) ? Number(retry) * 1e3 : Date.parse(retry) - Date.now();
	const id = headers?.get("request-id") ?? headers?.get("x-request-id") ?? headers?.get("x-deepseek-request-id");
	return new LlmError(message, code, {
		...status === void 0 ? {} : { status },
		...id ? { requestId: ProviderRequestId(id) } : {},
		...Number.isFinite(delay) && delay > 0 ? { providerRetryAfterMs: delay } : {}
	});
}
//#endregion
//#region vendor/dsh-llm/upstream/llm-deepseek/sse.ts
/** SSE framing delegated to eventsource-parser; JSON errors remain provider failures. */
/** Decode complete SSE frames without treating an unterminated tail as an event.
* @param body - provider response bytes.
* @param activity - pulse the idle watchdog for events and heartbeat comments.
* @returns JSON events, including message_stop; the translator owns completion.
*/
async function* parseSse(body, activity) {
	const events = body.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream({ onComment: activity }));
	for await (const frame of events) {
		activity();
		let raw;
		try {
			raw = JSON.parse(frame.data);
		} catch (_invalidSseJson) {
			throw new LlmError("DeepSeek Messages SSE contains invalid JSON", "MALFORMED_RESPONSE");
		}
		const event = object(raw);
		if (typeof event.type !== "string" || frame.event !== void 0 && frame.event !== event.type) throw new LlmError("DeepSeek Messages SSE event type mismatch", "MALFORMED_RESPONSE");
		if (event.type === "error") throw providerError(event, void 0);
		yield event;
	}
}
//#endregion
//#region vendor/dsh-llm/upstream/llm-deepseek/translate.ts
/** Translate Messages events while preserving block order and cumulative usage. */
/** Decode a required string from provider JSON.
* @param value - provider field.
* @returns the validated string.
*/
function string(value) {
	if (typeof value !== "string") throw new LlmError("DeepSeek Messages expected a string field", "MALFORMED_RESPONSE");
	return value;
}
function malformed(detail) {
	throw new LlmError(`DeepSeek Messages stream: ${detail}`, "MALFORMED_RESPONSE");
}
function indexOf(event) {
	if (!Number.isSafeInteger(event.index) || event.index < 0) return malformed("invalid block index");
	return event.index;
}
function updateUsage(usage, raw) {
	const fields = object(raw);
	for (const [wire, local] of Object.entries({
		input_tokens: "inputTokens",
		output_tokens: "outputTokens",
		cache_read_input_tokens: "cacheReadTokens",
		cache_creation_input_tokens: "cacheWriteTokens"
	})) {
		const value = fields[wire];
		if (value === void 0) continue;
		if (!Number.isSafeInteger(value) || value < 0) return malformed(`invalid ${wire}`);
		usage[local] = value;
	}
}
function startBlock(event, index) {
	const native = object(event.content_block);
	let content;
	let replay;
	switch (native.type) {
		case "text":
			content = {
				type: "text",
				text: string(native.text)
			};
			replay = { type: "text" };
			break;
		case "thinking":
			content = {
				type: "reasoning",
				text: string(native.thinking)
			};
			replay = {
				type: "reasoning",
				...native.signature === void 0 ? {} : { signature: string(native.signature) }
			};
			break;
		case "tool_use":
			content = {
				type: "tool-call",
				id: ToolCallId(string(native.id)),
				name: string(native.name),
				arguments: JSON.stringify(object(native.input))
			};
			if (!content.id || !content.name) return malformed("empty tool identity");
			replay = { type: "tool-call" };
			break;
		default: throw new LlmError(`DeepSeek Messages does not support response block ${String(native.type)}`, "UNSUPPORTED_CONTENT");
	}
	return {
		index,
		content,
		replay,
		closed: false,
		json: ""
	};
}
function deltaChunk(block, raw) {
	const delta = object(raw);
	const content = block.content;
	if (delta.type === "text_delta" && content.type === "text") {
		const text = string(delta.text);
		content.text += text;
		return {
			type: "text-delta",
			index: block.index,
			text
		};
	}
	if (delta.type === "thinking_delta" && content.type === "reasoning") {
		const text = string(delta.thinking);
		content.text += text;
		return {
			type: "reasoning-delta",
			index: block.index,
			text
		};
	}
	if (delta.type === "signature_delta" && content.type === "reasoning") {
		block.replay.signature = (block.replay.signature ?? "") + string(delta.signature);
		return;
	}
	if (delta.type === "input_json_delta" && content.type === "tool-call") {
		const argumentsDelta = string(delta.partial_json);
		block.json += argumentsDelta;
		return {
			type: "tool-call-delta",
			index: block.index,
			id: content.id,
			argumentsDelta
		};
	}
	return malformed(`unsupported delta ${String(delta.type)} for ${content.type}`);
}
function stopReason(raw) {
	switch (raw) {
		case "end_turn":
		case "stop_sequence": return { kind: "stop" };
		case "tool_use": return { kind: "tool-calls" };
		case "max_tokens": return { kind: "max-tokens" };
		default: return malformed(`unsupported stop reason ${String(raw)}`);
	}
}
/** Translate decoded SSE data into the Harness stream protocol.
* @param events - framed, decoded provider events in arrival order.
* @param model - requested model id stored in durable replay state.
* @returns blocks, one final usage value, and exactly one terminal finish.
*/
async function* translate(events, model) {
	const blocks = /* @__PURE__ */ new Map();
	const usage = {
		inputTokens: 0,
		outputTokens: 0
	};
	let started = false;
	let reason;
	for await (const event of events) {
		if (event.type === "message_start") {
			if (started) return malformed("duplicate message_start");
			updateUsage(usage, object(event.message).usage);
			started = true;
			continue;
		}
		if (![
			"content_block_start",
			"content_block_delta",
			"content_block_stop",
			"message_delta",
			"message_stop"
		].includes(String(event.type))) continue;
		if (!started) return malformed("event precedes message_start");
		if (event.type === "content_block_start") {
			const wireIndex = indexOf(event);
			if (blocks.has(wireIndex) || reason !== void 0) return malformed("block starts after settlement or repeats an index");
			const block = startBlock(event, blocks.size);
			blocks.set(wireIndex, block);
			yield {
				type: "block-start",
				index: block.index,
				blockType: block.content.type
			};
			if (block.content.type === "text" || block.content.type === "reasoning") {
				if (block.content.text) yield {
					type: block.content.type === "text" ? "text-delta" : "reasoning-delta",
					index: block.index,
					text: block.content.text
				};
			} else yield {
				type: "tool-call-delta",
				index: block.index,
				id: block.content.id,
				name: block.content.name,
				argumentsDelta: ""
			};
		} else if (event.type === "content_block_delta" || event.type === "content_block_stop") {
			const block = blocks.get(indexOf(event));
			if (block === void 0 || block.closed) return malformed("delta/stop without an open block");
			if (event.type === "content_block_delta") {
				const chunk = deltaChunk(block, event.delta);
				if (chunk !== void 0) yield chunk;
			} else {
				block.closed = true;
				if (block.content.type === "tool-call" && block.json.length > 0) block.content.arguments = block.json;
				yield {
					type: "block-end",
					index: block.index,
					block: { ...block.content }
				};
			}
		} else if (event.type === "message_delta") {
			const delta = object(event.delta);
			if (delta.stop_reason != null) reason = stopReason(delta.stop_reason);
			if (event.usage !== void 0) updateUsage(usage, event.usage);
		} else {
			if (reason === void 0 || [...blocks.values()].some((block) => !block.closed)) return malformed("message_stop without settled blocks and stop reason");
			if (blocks.size === 0 && reason.kind === "stop") throw new LlmError("DeepSeek Messages returned no content", "EMPTY_RESPONSE");
			if (reason.kind !== "max-tokens") for (const { content } of blocks.values()) {
				if (content.type !== "tool-call") continue;
				let parsed;
				try {
					parsed = JSON.parse(content.arguments);
				} catch (_invalidProviderToolJson) {
					return malformed("tool input is invalid JSON");
				}
				object(parsed);
			}
			usage.totalTokens = usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
			yield {
				type: "usage",
				usage
			};
			yield {
				type: "finish",
				reason,
				replayState: replayState(model, [...blocks.values()].map((block) => block.replay))
			};
			return;
		}
	}
	throw new LlmError("DeepSeek Messages stream ended before message_stop", "STREAM_CLOSED");
}
//#endregion
//#region vendor/dsh-llm/src/retry.ts
/**
* Retry policy for PPT_Agent model requests.
* Defaults are copied from DeepSeek Harness `packages/llm/llm/src/retry-policy.ts`
* (DEFAULT_MAX_RETRIES / DEFAULT_INITIAL_DELAY_MS / DEFAULT_MAX_DELAY_MS / DEFAULT_JITTER_RATIO / DEFAULT_RETRYABLE_CODES);
* `localDelay` is copied verbatim from `packages/llm/llm-retry/src/index.ts`.
* The upstream retry plugin runs at agent-step boundaries inside a cordis context; PPT_Agent has no agent loop,
* so the same policy is applied around one whole request (see ../src/client.ts).
*/
const DEFAULT_RETRY_POLICY = Object.freeze({
	mode: "normal",
	maxRetries: 5,
	retryableCodes: Object.freeze([
		EMPTY_RESPONSE_CODE,
		"RATE_LIMIT",
		"SERVER",
		"TIMEOUT",
		"TRANSPORT"
	]),
	initialDelayMs: 500,
	maxDelayMs: 1e4,
	jitterRatio: .1
});
function localDelay(config, retry, random) {
	const exponent = Math.min(retry - 1, 1024);
	const exponential = Math.min(config.initialDelayMs * 2 ** exponent, config.maxDelayMs);
	const jitter = 1 - config.jitterRatio + 2 * config.jitterRatio * random();
	return Math.min(exponential * jitter, config.maxDelayMs);
}
//#endregion
//#region vendor/dsh-llm/src/client.ts
/**
* PPT_Agent model client — a text-only cut of DeepSeek Harness `DeepSeekAdapter`
* (`packages/llm/llm-deepseek/src/adapter.ts`, `generate()` + `request()`):
* same Messages endpoint, headers, idle watchdog, SSE parsing (`sse.ts`), event translation (`translate.ts`)
* and error classification (`transport.ts`), all copied verbatim under ../upstream.
* Removed versus upstream: cordis plugin wiring, Files API / image offload, request extensions, tool calls,
* replay of previous assistant turns, account auth. Added: a whole-request retry loop using the upstream retry policy.
*/
/** Upstream default endpoint (`llm-deepseek` README: baseURL default). */
const DEFAULT_BASE_URL = "https://api.deepseek.com/anthropic";
/** Upstream default catalog (`llm-deepseek` README: models default). */
const DEFAULT_MODELS = ["deepseek-flash", "deepseek-v4-pro"];
function body(opts, input) {
	const effort = opts.reasoningEffort ?? "off";
	const messages = [];
	for (const m of input.messages) {
		const previous = messages.at(-1);
		if (previous?.role === m.role) previous.content.push({
			type: "text",
			text: m.text
		});
		else messages.push({
			role: m.role,
			content: [{
				type: "text",
				text: m.text
			}]
		});
	}
	return {
		model: opts.model,
		stream: true,
		messages,
		max_tokens: input.maxTokens ?? opts.maxTokens ?? 4096,
		thinking: { type: effort === "off" ? "disabled" : "enabled" },
		...effort === "off" ? {} : { output_config: { effort } },
		...input.system ? { system: input.system } : {},
		...input.temperature === void 0 ? {} : { temperature: input.temperature }
	};
}
/** One streamed request (no retry): yields upstream `StreamChunk`s. */
async function* stream(opts, input) {
	if (!opts.apiKey) throw new LlmError("DeepSeek API key is not configured", "MISSING_CREDENTIAL");
	const doFetch = opts.fetch ?? fetch;
	const consumer = new AbortController();
	const watchdog = idleWatchdog(input.signal === void 0 ? consumer.signal : AbortSignal.any([consumer.signal, input.signal]), opts.streamIdleTimeoutMs ?? 3e5, "MESSAGES_IDLE");
	const activity = () => {
		watchdog.pulse();
	};
	async function* request() {
		watchdog.signal.throwIfAborted();
		const response = await doFetch(`${messagesApiRoot(opts.baseURL || "https://api.deepseek.com/anthropic")}/messages`, {
			method: "POST",
			signal: watchdog.signal,
			body: JSON.stringify(body(opts, input)),
			redirect: "error",
			headers: {
				"user-agent": opts.userAgent ?? "PPT_Agent",
				"content-type": "application/json",
				"accept": "text/event-stream",
				"x-api-key": opts.apiKey,
				"anthropic-version": "2023-06-01"
			}
		});
		if (!response.ok) {
			const text = await response.text();
			let raw;
			try {
				raw = JSON.parse(text);
			} catch (_nonJsonGatewayError) {}
			const failure = providerError(raw, response.status, response.headers);
			throw new LlmError(failure.message, failure.code, {
				...failure.failure,
				cause: new Error(text.slice(0, 2e3))
			});
		}
		if (response.body === null) throw new LlmError("DeepSeek Messages returned no response body", "EMPTY_RESPONSE");
		yield* translate(parseSse(response.body, activity), opts.model);
	}
	const iterator = request();
	try {
		while (true) {
			const next = await watchdog.next(iterator);
			if (next.done) return;
			yield next.value;
		}
	} catch (error) {
		if (timeoutOf(watchdog.signal, "MESSAGES_IDLE") !== void 0) throw new LlmError("DeepSeek Messages stream idle timeout", "TIMEOUT", { cause: error });
		if (input.signal?.aborted) throw new LlmError("DeepSeek Messages request aborted", "ABORTED", { cause: error });
		if (error instanceof LlmError) throw error;
		throw new LlmError("DeepSeek Messages transport failed", "TRANSPORT", { cause: error });
	} finally {
		consumer.abort();
		watchdog[Symbol.dispose]();
		iterator.return(void 0).catch(() => {});
	}
}
const defaultSleep = (ms, signal) => new Promise((resolve, reject) => {
	const t = setTimeout(() => {
		signal?.removeEventListener("abort", onAbort);
		resolve();
	}, ms);
	const onAbort = () => {
		clearTimeout(t);
		reject(new LlmError("DeepSeek Messages request aborted", "ABORTED"));
	};
	signal?.addEventListener("abort", onAbort, { once: true });
});
/** Complete one chat: collects text, retries transient failures with the upstream policy. */
async function complete(opts, input) {
	const policy = {
		...DEFAULT_RETRY_POLICY,
		...opts.retry || {}
	};
	const sleep = opts.sleep ?? defaultSleep;
	const t0 = Date.now();
	for (let attempt = 1;; attempt++) {
		let text = "", reasoning = "", finish = "", usage;
		try {
			for await (const chunk of stream(opts, input)) if (chunk.type === "text-delta") {
				text += chunk.text;
				input.onDelta?.(chunk.text);
			} else if (chunk.type === "reasoning-delta") reasoning += chunk.text;
			else if (chunk.type === "usage") usage = chunk.usage;
			else if (chunk.type === "finish") finish = chunk.reason.kind;
			if (!text.trim()) throw new LlmError("DeepSeek Messages returned no text", "EMPTY_RESPONSE");
			return {
				text,
				reasoning,
				finish,
				usage,
				attempts: attempt,
				ms: Date.now() - t0
			};
		} catch (error) {
			const code = error instanceof LlmError ? error.code : "TRANSPORT";
			if (attempt > policy.maxRetries || !policy.retryableCodes.includes(code) || input.signal?.aborted) throw error;
			const after = error instanceof LlmError ? error.failure.providerRetryAfterMs : void 0;
			await sleep(after !== void 0 ? Math.min(after, policy.maxDelayMs) : localDelay(policy, attempt, opts.random ?? Math.random), input.signal);
		}
	}
}
//#endregion
exports.DEFAULT_BASE_URL = DEFAULT_BASE_URL;
exports.DEFAULT_MODELS = DEFAULT_MODELS;
exports.DEFAULT_RETRY_POLICY = DEFAULT_RETRY_POLICY;
exports.HarnessError = HarnessError;
exports.LlmError = LlmError;
exports.complete = complete;
exports.errorChain = errorChain;
exports.idleWatchdog = idleWatchdog;
exports.isContextWindowExceededError = isContextWindowExceededError;
exports.isQuotaExceededError = isQuotaExceededError;
exports.localDelay = localDelay;
exports.messagesApiRoot = messagesApiRoot;
exports.parseSse = parseSse;
exports.providerError = providerError;
exports.stream = stream;
exports.translate = translate;
