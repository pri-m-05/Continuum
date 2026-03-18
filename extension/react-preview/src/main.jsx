import React from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";

const roots = new Map();

function getRoot(target) {
  const container = typeof target === "string" ? document.getElementById(target) : target;
  if (!container) return null;

  if (!roots.has(container)) {
    roots.set(container, createRoot(container));
  }

  return roots.get(container);
}

function Preview({ markdown }) {
  return (
    <div className="md-rendered" style={{ fontFamily: "Arial, sans-serif", fontSize: 13 }}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
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