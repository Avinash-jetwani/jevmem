"""Command line: python3 -m pagewright path/to/site.json"""

import argparse
import os
import sys

from .build import BuildError, build_site
from .config import ConfigError, load_config


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="pagewright", description="Build a static site from Markdown files."
    )
    parser.add_argument("config", nargs="?", default="site.json", help="the site's JSON config")
    args = parser.parse_args(argv)

    try:
        config = load_config(args.config)
        pages = build_site(config)
    except (OSError, ConfigError, BuildError) as exc:
        print(f"pagewright: {exc}", file=sys.stderr)
        return 1

    output_dir = os.path.join(config.root, config.output_dir)
    print(f"built {len(pages)} page(s) and the index into {output_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
