import { createGlobalStyle } from 'styled-components';

export default createGlobalStyle`
  *, *::before, *::after {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
  }

  html, body {
    height: 100%;
    width: 100%;
    line-height: 1.5;
    -webkit-tap-highlight-color: transparent;
    -webkit-text-size-adjust: none;
    touch-action: manipulation;
    background: #fff;
    overflow: hidden;
  }

  body, textarea, input, button, select {
    font-family: "Cormorant", Georgia, "Times New Roman", serif;
    color: #000;
    font-size: 16px;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }

  #root {
    height: 100%;
    width: 100%;
  }

  button, input, textarea, select {
    outline: none;
    border: none;
    border-radius: 0;
    background: none;
    -webkit-appearance: none;
    -moz-appearance: none;
    appearance: none;
  }

  input:focus, textarea:focus {
    outline: none;
  }

  button {
    cursor: pointer;
    user-select: none;
  }

  a {
    text-decoration: none;
    color: inherit;
  }

  ::selection {
    background: rgba(0, 0, 0, 0.08);
  }
`;
