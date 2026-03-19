import React from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";

const roots = new Map();

const markdownSchema = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    src: [...(defaultSchema.protocols?.src || []), "data", "http", "https"],
    href: [...(defaultSchema.protocols?.href || []), "http", "https", "mailto"]
  }
};

function getRoot(target) {
  const container = typeof target === "string" ? document.getElementById(target) : target;
  if (!container) return null;

  if (!roots.has(container)) {
    roots.set(container, createRoot(container));
  }

  return roots.get(container);
}

function flattenChildrenText(children) {
  return React.Children.toArray(children)
    .map((child) => {
      if (typeof child === "string" || typeof child === "number") {
        return String(child);
      }

      if (React.isValidElement(child) && child.props?.children) {
        return flattenChildrenText(child.props.children);
      }

      return "";
    })
    .join("")
    .trim();
}

function shortLinkLabel(href) {
  try {
    const url = new URL(href);
    const host = url.hostname.replace(/^www\./, "");
    const parts = url.pathname.split("/").filter(Boolean);
    const tail = parts[parts.length - 1];

    if (!parts.length) return host;
    if (tail && tail.length <= 18) return `${host}/${tail}`;
    return host;
  } catch {
    return "Open link";
  }
}

function Preview({ markdown }) {
  return (
    <div className="md-rendered" style={{ fontFamily: "Arial, sans-serif", fontSize: 13 }}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeSanitize, markdownSchema]]}
        components={{
          a({ href, children, ...props }) {
            const childText = flattenChildrenText(children);
            const looksLikeRawUrl =
              !!href && (!childText || childText === href || /^https?:\/\//i.test(childText));

            return (
              <a href={href} target="_blank" rel="noreferrer noopener" {...props}>
                {looksLikeRawUrl ? shortLinkLabel(href) : children}
              </a>
            );
          }
        }}
      >
        {markdown || "Select an item."}
      </ReactMarkdown>
    </div>
  );
}

window.renderMarkdownInto = (target, markdown) => {
  const appRoot = getRoot(target);
  if (!appRoot) return;
  appRoot.render(<Preview markdown={markdown} />);
};

window.renderMarkdownPreview = (markdown) => {
  window.renderMarkdownInto("preview", markdown);
};