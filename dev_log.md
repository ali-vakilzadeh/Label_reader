# Project Progress Report and Daily Activity Log

## Project Completion check list

(note: percents indicated weight of required work)

```
[☑️] Primary Client Session to Review Problem and Operational Requirements.

[☑️] Project overall scope, architecture and specification

[🔃] Technical Specification + Process Workflow

[🔃] _Main Project Components_

    [>>] _Android APP_
    
        [☑️] Proof of concept  (10%)
        
        [☑️] prototype  (20%)
        
        [☑️] Demo mode  (10%)
        
        [↔️] Middleware connectivity + AI Vision test  (30%)
        
        [  ] Developer stage debugging  (10%)
        
        [  ] End user stage debugging   (20%)
        
    [🔃] Middleware
    
        [🔃] Proof of concept  (10%)
        
        [🔃] prototype  (20%)
        
        [🔃] Demo mode  (10%)
        
        [  ] Middleware connectivity + AI Vision test  (30%)
        
        [  ] Developer stage debugging  (10%)
        
        [  ] End user stage debugging   (20%)
        
    [  ] Analytical Dashboard
    
        [☑️] Proof of concept  (10%)
        
        [  ] prototype  (20%)
        
        [  ] Demo mode  (10%)
        
        [  ] Middleware connectivity + AI Vision test  (30%)
        
        [  ] Developer stage debugging  (10%)
        
        [  ] End user stage debugging   (20%)
        
[  ] Project Deploy on user server

[  ] User Guide Pages

[  ] Final Documentation
```

## 2026-08-23

- Final Agreement with client (Mr. K. Navoyan - OutFit.am Co.)
- Client sensitive points announce:
    1. End to end integrity of mobile app - Manual data synchronization to server (mobile user send data via CSV file format)
    2. Zero data loss in AI transmit/Result receive.
    3. User Review of Uncertain Readings
    4. Final Test on Real samples at user premises.
    5. Full documentation on project design and deployment

## 2026-08-24

- Data workflow (App > Middleware > AI > Middleware > App) detail design
- Tie-points, multi-user (multiple app concurrent connections) protocol, Data persistence, Idempotency check
- App mockup (figma) completed
- App database design


## 2026-08-25

- App / Server communication protocol (API Contract) finalized.
- App operation process finalized
- App prototype updated
- Middleware draft structure constructed
- Middleware security design
- Middleware database design

## 2026-08-26

- Draft function list / feature list for Analytical dashboard prepared
- Middleware prototype updated (app connectivity - AI actions)

## 2026-07-27

- Review and update all code (Mobile APP + Server MiddleWare + Dashboard):
- Zero Data Loss Policy - implemented in all components.
- Improved data consistency in failed cases
- Raw table cleanup (Subcategories / Colors / Country Codes )
