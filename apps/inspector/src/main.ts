import React from "react";
import { createRoot } from "react-dom/client";
import { InspectorApp } from "./InspectorApp";
import "./styles.css";

const root = createRoot(document.getElementById("root")!);
root.render(React.createElement(InspectorApp));
