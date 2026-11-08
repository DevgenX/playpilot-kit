#if (DEVELOPMENT_BUILD || UNITY_EDITOR) && !PLAYPILOT_DISABLE
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace PlayPilotKit
{
    /// <summary>
    /// Minimal JSON writer and parser for the probe files. Self-contained (no UnityEngine,
    /// no third-party JSON library) so it works with dictionaries and on every platform.
    /// </summary>
    internal static class PlayPilotJson
    {
        const int MaxDepth = 64;

        // ---------------------------------------------------------------- writer

        /// <summary>Appends <paramref name="value"/> as a quoted, escaped JSON string (null writes null).</summary>
        public static void WriteString(StringBuilder sb, string value)
        {
            if (value == null)
            {
                sb.Append("null");
                return;
            }
            sb.Append('"');
            for (int i = 0; i < value.Length; i++)
            {
                char c = value[i];
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\b': sb.Append("\\b"); break;
                    case '\f': sb.Append("\\f"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20)
                        {
                            sb.Append("\\u00");
                            sb.Append(HexDigit(c >> 4));
                            sb.Append(HexDigit(c & 0xF));
                        }
                        else
                        {
                            // Everything else, including non-ASCII, passes through; files are UTF-8.
                            sb.Append(c);
                        }
                        break;
                }
            }
            sb.Append('"');
        }

        /// <summary>
        /// Appends any supported value: null, string, bool, the built-in numeric types,
        /// IDictionary&lt;string, object&gt; and IList. Anything else is written as its ToString() string.
        /// </summary>
        public static void WriteValue(StringBuilder sb, object value)
        {
            WriteValue(sb, value, 0);
        }

        static void WriteValue(StringBuilder sb, object value, int depth)
        {
            if (depth > MaxDepth)
                throw new FormatException("JSON value nested deeper than " + MaxDepth);

            switch (value)
            {
                case null: sb.Append("null"); return;
                case string s: WriteString(sb, s); return;
                case bool b: sb.Append(b ? "true" : "false"); return;
                case double d: WriteDouble(sb, d); return;
                case float f:
                    // "R" on the float itself avoids widening noise (0.1f -> 0.100000001490116).
                    if (float.IsNaN(f) || float.IsInfinity(f)) sb.Append("null");
                    else sb.Append(f.ToString("R", CultureInfo.InvariantCulture));
                    return;
                case int i: AppendInteger(sb, i); return;
                case long l: AppendInteger(sb, l); return;
                case short sh: AppendInteger(sb, sh); return;
                case sbyte sb8: AppendInteger(sb, sb8); return;
                case byte u8: AppendInteger(sb, u8); return;
                case ushort u16: AppendInteger(sb, u16); return;
                case uint u32: AppendInteger(sb, u32); return;
                case ulong u64: sb.Append(u64.ToString(CultureInfo.InvariantCulture)); return;
                case decimal m: sb.Append(m.ToString(CultureInfo.InvariantCulture)); return;
                case IDictionary<string, object> dict:
                {
                    sb.Append('{');
                    bool first = true;
                    foreach (var pair in dict)
                    {
                        if (!first) sb.Append(',');
                        first = false;
                        WriteString(sb, pair.Key);
                        sb.Append(':');
                        WriteValue(sb, pair.Value, depth + 1);
                    }
                    sb.Append('}');
                    return;
                }
                case IList list:
                {
                    sb.Append('[');
                    for (int i = 0; i < list.Count; i++)
                    {
                        if (i > 0) sb.Append(',');
                        WriteValue(sb, list[i], depth + 1);
                    }
                    sb.Append(']');
                    return;
                }
                default: WriteString(sb, value.ToString()); return;
            }
        }

        /// <summary>Appends a double with round-trip precision; NaN and infinities become null.</summary>
        public static void WriteDouble(StringBuilder sb, double value)
        {
            if (double.IsNaN(value) || double.IsInfinity(value)) sb.Append("null");
            else sb.Append(value.ToString("R", CultureInfo.InvariantCulture));
        }

        /// <summary>
        /// Appends a number rounded to 4 decimals without allocating (used for target
        /// coordinates, which are rescanned several times a second). NaN and infinities become null.
        /// </summary>
        public static void WriteFixed4(StringBuilder sb, double value)
        {
            if (double.IsNaN(value) || double.IsInfinity(value) || Math.Abs(value) > 1e12)
            {
                WriteDouble(sb, value); // null for NaN/infinity; huge values keep full form
                return;
            }
            long scaled = (long)Math.Round(value * 10000.0, MidpointRounding.AwayFromZero);
            if (scaled < 0)
            {
                sb.Append('-');
                scaled = -scaled;
            }
            AppendInteger(sb, scaled / 10000);
            long frac = scaled % 10000;
            if (frac == 0) return;
            sb.Append('.');
            // Emit up to four digits and drop trailing zeros: 0.5000 -> 0.5.
            for (long div = 1000; div > 0 && frac > 0; div /= 10)
            {
                sb.Append((char)('0' + frac / div));
                frac %= div;
            }
        }

        /// <summary>Appends an integer in invariant form without allocating.</summary>
        public static void AppendInteger(StringBuilder sb, long value)
        {
            if (value == long.MinValue)
            {
                sb.Append("-9223372036854775808");
                return;
            }
            if (value < 0)
            {
                sb.Append('-');
                value = -value;
            }
            long div = 1;
            while (value / div >= 10) div *= 10;
            for (; div > 0; div /= 10)
                sb.Append((char)('0' + (value / div) % 10));
        }

        static char HexDigit(int n) => (char)(n < 10 ? '0' + n : 'a' + n - 10);

        // ---------------------------------------------------------------- parser

        /// <summary>
        /// Parses one JSON document. Objects become Dictionary&lt;string, object&gt;, arrays
        /// List&lt;object&gt;, numbers double, plus string, bool and null.
        /// Throws FormatException on malformed input.
        /// </summary>
        public static object Parse(string json)
        {
            if (json == null) throw new FormatException("JSON text is null");
            var parser = new Parser(json);
            parser.SkipWhitespace();
            object result = parser.ParseValue(0);
            parser.SkipWhitespace();
            if (!parser.AtEnd) throw parser.Error("unexpected text after the JSON value");
            return result;
        }

        struct Parser
        {
            readonly string _s;
            int _pos;

            public Parser(string s)
            {
                _s = s;
                // A UTF-8 byte order mark is not JSON, but some writers add one.
                _pos = s.Length > 0 && s[0] == '﻿' ? 1 : 0;
            }

            public bool AtEnd => _pos >= _s.Length;

            public FormatException Error(string what) =>
                new FormatException("Invalid JSON at position " + _pos + ": " + what);

            public void SkipWhitespace()
            {
                while (_pos < _s.Length)
                {
                    char c = _s[_pos];
                    if (c != ' ' && c != '\t' && c != '\n' && c != '\r') break;
                    _pos++;
                }
            }

            public object ParseValue(int depth)
            {
                if (depth > MaxDepth) throw Error("nested deeper than " + MaxDepth);
                if (AtEnd) throw Error("unexpected end of input");
                char c = _s[_pos];
                switch (c)
                {
                    case '{': return ParseObject(depth);
                    case '[': return ParseArray(depth);
                    case '"': return ParseString();
                    case 't': ExpectWord("true"); return true;
                    case 'f': ExpectWord("false"); return false;
                    case 'n': ExpectWord("null"); return null;
                    default:
                        if (c == '-' || (c >= '0' && c <= '9')) return ParseNumber();
                        throw Error("unexpected character '" + c + "'");
                }
            }

            Dictionary<string, object> ParseObject(int depth)
            {
                var result = new Dictionary<string, object>();
                _pos++; // {
                SkipWhitespace();
                if (Peek() == '}')
                {
                    _pos++;
                    return result;
                }
                while (true)
                {
                    SkipWhitespace();
                    if (Peek() != '"') throw Error("expected a property name");
                    string key = ParseString();
                    SkipWhitespace();
                    if (Peek() != ':') throw Error("expected ':'");
                    _pos++;
                    SkipWhitespace();
                    result[key] = ParseValue(depth + 1); // duplicate keys: last one wins
                    SkipWhitespace();
                    char c = Peek();
                    _pos++;
                    if (c == '}') return result;
                    if (c != ',') throw Error("expected ',' or '}'");
                }
            }

            List<object> ParseArray(int depth)
            {
                var result = new List<object>();
                _pos++; // [
                SkipWhitespace();
                if (Peek() == ']')
                {
                    _pos++;
                    return result;
                }
                while (true)
                {
                    SkipWhitespace();
                    result.Add(ParseValue(depth + 1));
                    SkipWhitespace();
                    char c = Peek();
                    _pos++;
                    if (c == ']') return result;
                    if (c != ',') throw Error("expected ',' or ']'");
                }
            }

            string ParseString()
            {
                _pos++; // opening quote
                var sb = new StringBuilder();
                while (true)
                {
                    if (AtEnd) throw Error("unterminated string");
                    char c = _s[_pos++];
                    if (c == '"') return sb.ToString();
                    if (c < 0x20) throw Error("control character in string");
                    if (c != '\\')
                    {
                        sb.Append(c);
                        continue;
                    }
                    if (AtEnd) throw Error("unterminated escape");
                    char e = _s[_pos++];
                    switch (e)
                    {
                        case '"': sb.Append('"'); break;
                        case '\\': sb.Append('\\'); break;
                        case '/': sb.Append('/'); break;
                        case 'b': sb.Append('\b'); break;
                        case 'f': sb.Append('\f'); break;
                        case 'n': sb.Append('\n'); break;
                        case 'r': sb.Append('\r'); break;
                        case 't': sb.Append('\t'); break;
                        case 'u':
                            // Surrogate pairs arrive as two \u escapes and recombine naturally.
                            if (_pos + 4 > _s.Length) throw Error("short \\u escape");
                            int code = 0;
                            for (int i = 0; i < 4; i++)
                            {
                                int h = HexValue(_s[_pos++]);
                                if (h < 0) throw Error("bad hex digit in \\u escape");
                                code = (code << 4) | h;
                            }
                            sb.Append((char)code);
                            break;
                        default: throw Error("unknown escape '\\" + e + "'");
                    }
                }
            }

            double ParseNumber()
            {
                int start = _pos;
                if (Peek() == '-') _pos++;
                if (Peek() == '0') _pos++;
                else if (!SkipDigits()) throw Error("expected a digit");
                if (Peek() == '.')
                {
                    _pos++;
                    if (!SkipDigits()) throw Error("expected a digit after '.'");
                }
                if (Peek() == 'e' || Peek() == 'E')
                {
                    _pos++;
                    if (Peek() == '+' || Peek() == '-') _pos++;
                    if (!SkipDigits()) throw Error("expected a digit in the exponent");
                }
                double value;
                try
                {
                    value = double.Parse(_s.Substring(start, _pos - start), NumberStyles.Float, CultureInfo.InvariantCulture);
                }
                catch (OverflowException)
                {
                    // Older runtimes throw here; newer ones return infinity (handled below).
                    throw Error("number out of range");
                }
                if (double.IsInfinity(value)) throw Error("number out of range");
                return value;
            }

            bool SkipDigits()
            {
                int start = _pos;
                while (_pos < _s.Length && _s[_pos] >= '0' && _s[_pos] <= '9') _pos++;
                return _pos > start;
            }

            void ExpectWord(string word)
            {
                if (string.CompareOrdinal(_s, _pos, word, 0, word.Length) != 0) throw Error("expected '" + word + "'");
                _pos += word.Length;
            }

            char Peek() => _pos < _s.Length ? _s[_pos] : '\0';

            static int HexValue(char c)
            {
                if (c >= '0' && c <= '9') return c - '0';
                if (c >= 'a' && c <= 'f') return c - 'a' + 10;
                if (c >= 'A' && c <= 'F') return c - 'A' + 10;
                return -1;
            }
        }
    }
}
#endif
