"""
Simple Click-and-Scrape
Just clicks each event and scrapes whatever page opens
"""

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.chrome.service import Service
from webdriver_manager.chrome import ChromeDriverManager
import csv
import json
import time
from datetime import datetime

SEARCH_URL = 'https://caleprocure.ca.gov/pages/Events-BS3/event-search.aspx'
OUTPUT_CSV = 'all_events_detailed.csv'
OUTPUT_JSON = 'all_events_detailed.json'

def scrape_current_page(driver, wait):
    """Scrape data from whatever page we're currently on - using your proven code"""
    event_data = {
        'event_url': driver.current_url,  # Just get whatever URL we're on
        'event_id': '',
        'title': '',
        'description': '',
        'contact_name': '',
        'contact_email': '',
        'contact_phone': '',
        'department': '',
        'start_date': '',
        'end_date': '',
        'format': ''
    }
    
    # Extract event ID from URL
    parts = driver.current_url.split('/')
    if len(parts) >= 4:
        event_data['event_id'] = f"{parts[-2]}/{parts[-1]}"
    
    # Wait for JavaScript to load data
    try:
        wait.until(
            EC.presence_of_element_located((By.CSS_SELECTOR, '[data-if-label="eventName"]'))
        )
        # Give extra time for all data to load
        time.sleep(3)
    except:
        pass
    
    # Extract title
    try:
        title_elem = driver.find_element(By.CSS_SELECTOR, '[data-if-label="eventName"]')
        title = title_elem.text.strip()
        if title and title != '[Event Title]':
            event_data['title'] = title
    except:
        pass
    
    # Extract description
    try:
        desc_elem = driver.find_element(By.CSS_SELECTOR, '[data-if-label="descriptiondetails"]')
        desc = desc_elem.text.strip()
        if desc and desc != '[Detail Description]':
            event_data['description'] = desc
    except:
        pass
    
    # Extract contact name
    try:
        contact_elem = driver.find_element(By.CSS_SELECTOR, '[data-if-label="contactName"]')
        contact = contact_elem.text.strip()
        if contact and contact != '[Contact Name]':
            event_data['contact_name'] = contact
    except:
        pass
    
    # Extract email
    try:
        email_elem = driver.find_element(By.CSS_SELECTOR, '[data-if-label="emailAnchor"]')
        email = email_elem.text.strip()
        if email and email != '[EmailAddress]':
            event_data['contact_email'] = email
    except:
        try:
            email_elem = driver.find_element(By.ID, 'RESP_INQ_DL0_WK_EMAILID')
            email = email_elem.text.strip()
            if email:
                event_data['contact_email'] = email
        except:
            pass
    
    # Extract phone
    try:
        phone_elem = driver.find_element(By.CSS_SELECTOR, '[data-if-label="phoneText"]')
        phone = phone_elem.text.strip()
        if phone and phone != '[Phone Number]':
            event_data['contact_phone'] = phone
    except:
        pass
    
    # Extract department
    try:
        dept_elem = driver.find_element(By.CSS_SELECTOR, '[data-if-label="dept"]')
        dept = dept_elem.text.strip()
        if dept:
            event_data['department'] = dept
    except:
        pass
    
    # Extract start date
    try:
        start_elem = driver.find_element(By.CSS_SELECTOR, '[data-if-label="eventStartDate"]')
        start_date = start_elem.text.strip()
        if start_date:
            event_data['start_date'] = start_date
    except:
        pass
    
    # Extract end date
    try:
        end_elem = driver.find_element(By.CSS_SELECTOR, '[data-if-label="eventEndDate"]')
        end_date = end_elem.text.strip()
        if end_date:
            event_data['end_date'] = end_date
    except:
        pass
    
    # Extract format
    try:
        format1_elem = driver.find_element(By.CSS_SELECTOR, '[data-if-label="format1"]')
        format2_elem = driver.find_element(By.CSS_SELECTOR, '[data-if-label="format2"]')
        format1 = format1_elem.text.strip()
        format2 = format2_elem.text.strip()
        if format1 or format2:
            event_data['format'] = f"{format1} / {format2}".strip(' /')
    except:
        pass
    
    return event_data


def main():
    print("\n" + "=" * 80)
    print("Simple Click-and-Scrape")
    print("=" * 80)
    
    # Set up Chrome
    options = webdriver.ChromeOptions()
    options.add_argument('--no-sandbox')
    options.add_argument('--disable-dev-shm-usage')
    options.add_argument('--window-size=1920,1080')
    # options.add_argument('--headless')  # Uncomment to hide browser
    
    service = Service(ChromeDriverManager().install())
    driver = webdriver.Chrome(service=service, options=options)
    wait = WebDriverWait(driver, 20)
    
    all_events = []
    
    try:
        # Load search page
        print("\n1. Loading search page...")
        driver.get(SEARCH_URL)
        
        print("2. Waiting for data...")
        time.sleep(10)
        
        # Count events
        print("\n3. Counting events...")
        all_rows = driver.find_elements(By.CSS_SELECTOR, '[data-if-label^="tblBodyTr"]')
        visible_rows = [row for row in all_rows if 'if-hide' not in (row.get_attribute('class') or '') and row.is_displayed()]
        total_events = len(visible_rows)
        print(f"   Found {total_events} events")
        
        print("\n4. Scraping events...")
        print("=" * 80)
        
        # Process each event
        for i in range(total_events):
            print(f"\nEvent {i+1}/{total_events}:")
            
            try:
                # Always reload search page to avoid stale elements
                driver.get(SEARCH_URL)
                time.sleep(3)
                
                # Find all rows again
                all_rows = driver.find_elements(By.CSS_SELECTOR, '[data-if-label^="tblBodyTr"]')
                visible_rows = [row for row in all_rows if 'if-hide' not in (row.get_attribute('class') or '') and row.is_displayed()]
                
                if i >= len(visible_rows):
                    print("  ⚠ Row not found, skipping")
                    continue
                
                row = visible_rows[i]
                
                # Get event ID for display
                try:
                    event_id_text = row.find_element(By.CSS_SELECTOR, '[data-if-label="tdEventId"]').text.strip()
                    print(f"  ID: {event_id_text}")
                except:
                    pass
                
                # Click the event
                try:
                    event_id_cell = row.find_element(By.CSS_SELECTOR, '[data-if-label="tdEventId"]')
                    print(f"  Clicking...")
                    event_id_cell.click()
                    time.sleep(2)
                except Exception as e:
                    print(f"  ✗ Error clicking: {e}")
                    continue
                
                # Scrape whatever page we're on now
                print(f"  Scraping current page...")
                event_data = scrape_current_page(driver, wait)
                
                # Show what we got
                if event_data['title']:
                    print(f"  ✓ Title: {event_data['title'][:60]}...")
                if event_data['contact_email']:
                    print(f"    Contact: {event_data['contact_email']}")
                if event_data['end_date']:
                    print(f"    End Date: {event_data['end_date']}")
                
                all_events.append(event_data)
                
                # Save progress every 10 events
                if len(all_events) % 10 == 0:
                    with open(OUTPUT_JSON, 'w', encoding='utf-8') as f:
                        json.dump({
                            'scrape_date': datetime.now().isoformat(),
                            'total_events': len(all_events),
                            'events': all_events
                        }, f, indent=2, ensure_ascii=False)
                    print(f"  💾 Progress saved ({len(all_events)} events)")
                
            except KeyboardInterrupt:
                print("\n\n⚠ Interrupted by user")
                break
            except Exception as e:
                print(f"  ✗ Error: {e}")
                continue
        
        # Save final results
        print("\n" + "=" * 80)
        print(f"Scraping complete! Collected {len(all_events)} events")
        
        # Save CSV
        if all_events:
            print(f"\nSaving to {OUTPUT_CSV}...")
            fieldnames = [
                'event_id', 'event_url', 'title', 'description',
                'department', 'format', 'start_date', 'end_date',
                'contact_name', 'contact_email', 'contact_phone'
            ]
            
            with open(OUTPUT_CSV, 'w', newline='', encoding='utf-8') as f:
                writer = csv.DictWriter(f, fieldnames=fieldnames)
                writer.writeheader()
                writer.writerows(all_events)
            print(f"✓ Saved to {OUTPUT_CSV}")
        
        # Save JSON
        if all_events:
            print(f"Saving to {OUTPUT_JSON}...")
            with open(OUTPUT_JSON, 'w', encoding='utf-8') as f:
                json.dump({
                    'scrape_date': datetime.now().isoformat(),
                    'total_events': len(all_events),
                    'events': all_events
                }, f, indent=2, ensure_ascii=False)
            print(f"✓ Saved to {OUTPUT_JSON}")
        
        print("\n" + "=" * 80)
        print("✓ All done!")
        
        if all_events:
            print(f"\nTotal events scraped: {len(all_events)}")
            print("\nSample of first event:")
            first = all_events[0]
            print(f"  Event ID: {first['event_id']}")
            print(f"  Title: {first['title']}")
            print(f"  Contact: {first['contact_email']}")
        
    except Exception as e:
        print(f"\n✗ Error: {e}")
        import traceback
        traceback.print_exc()
    
    finally:
        driver.quit()
        print("\nBrowser closed.")


if __name__ == '__main__':
    main()