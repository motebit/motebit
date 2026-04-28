import React from "react";
import { createRoot } from "react-dom/client";
import { OperatorApp } from "./OperatorApp";
import "./styles.css";

const root = createRoot(document.getElementById("root")!);
root.render(React.createElement(OperatorApp));
