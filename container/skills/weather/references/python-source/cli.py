#!/usr/bin/env python3
"""
Weather Skill CLI interface.

Command-line interface for testing and standalone use of the weather skill.

Usage:
    weather --location "Hong Kong"
    weather --location "Hong Kong" --forecast --days 3
    weather --location "Hong Kong" --format telegram --send
    weather --help
"""

import argparse
import asyncio
import json
import sys
from dataclasses import asdict

from .bootstrap import build_default_skill
from .skill import NoProviderError


def create_parser() -> argparse.ArgumentParser:
    """Create CLI argument parser."""
    parser = argparse.ArgumentParser(
        prog="weather",
        description="Fetch weather information for any location",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  weather --location "Hong Kong"
  weather -l "Hong Kong" --forecast --days 5
  weather -l "Hong Kong" --format telegram
  weather -l "Hong Kong" --format json
  weather -l "Hong Kong" --send --chat-id "YOUR_CHAT_ID"
        """
    )

    parser.add_argument(
        "-l", "--location",
        type=str,
        default="Hong Kong",
        help="Location to fetch weather for (default: Hong Kong)"
    )

    parser.add_argument(
        "-f", "--forecast",
        action="store_true",
        help="Fetch forecast instead of current weather"
    )

    parser.add_argument(
        "-d", "--days",
        type=int,
        default=3,
        help="Number of forecast days (default: 3)"
    )

    parser.add_argument(
        "--format",
        type=str,
        choices=["text", "telegram", "whatsapp", "json"],
        default="text",
        help="Output format (default: text)"
    )

    parser.add_argument(
        "--send",
        action="store_true",
        help="Send to configured channel (requires Telegram setup)"
    )

    parser.add_argument(
        "--chat-id",
        type=str,
        help="Override chat ID for sending"
    )

    parser.add_argument(
        "--topic-id",
        type=int,
        help="Telegram topic/thread ID"
    )

    parser.add_argument(
        "--provider",
        type=str,
        default="auto",
        help="Weather provider name (default: auto — uses priority chain)"
    )

    parser.add_argument(
        "-v", "--verbose",
        action="store_true",
        help="Verbose output"
    )

    return parser


async def main(args: argparse.Namespace) -> int:
    """Main entry point."""
    try:
        if args.send and args.format == "json":
            print(
                "Error: --send is not compatible with --format json",
                file=sys.stderr,
            )
            return 2

        if args.verbose:
            print(f"Fetching weather for: {args.location}", file=sys.stderr)

        skill = build_default_skill()
        provider_name = None if args.provider == "auto" else args.provider

        if provider_name and not any(p.name == provider_name for p in skill.providers):
            names = ", ".join(sorted(p.name for p in skill.providers))
            raise NoProviderError(
                f"Provider not found: {provider_name}\n"
                f"Available providers: {names}"
            )

        if args.forecast:
            data = await skill.get_forecast(args.location, args.days, provider_name)
        else:
            data = await skill.get_current(args.location, provider_name)

        if args.format == "json":
            if isinstance(data, list):
                output = [asdict(d) for d in data]
            else:
                output = asdict(data)
            print(json.dumps(output, indent=2, default=str))
            return 0

        message = skill.format(data, platform=args.format)

        if args.send:
            result = await skill.send(
                message, channel="telegram",
                chat_id=args.chat_id, topic_id=args.topic_id
            )
            if result.success:
                print("✓ Message sent successfully", file=sys.stderr)
                return 0
            else:
                print(f"✗ Failed: {result.error}", file=sys.stderr)
                return 1
        else:
            print(message)
            return 0

    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        if args.verbose:
            import traceback
            traceback.print_exc()
        return 1


def cli():
    """CLI entry point."""
    parser = create_parser()
    args = parser.parse_args()
    return asyncio.run(main(args))


if __name__ == "__main__":
    sys.exit(cli())
